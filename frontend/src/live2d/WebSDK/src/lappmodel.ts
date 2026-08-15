// @ts-nocheck
/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismDefaultParameterId } from "@framework/cubismdefaultparameterid";
import { CubismModelSettingJson } from "@framework/cubismmodelsettingjson";
import {
  BreathParameterData,
  CubismBreath,
} from "@framework/effect/cubismbreath";
import { CubismEyeBlink } from "@framework/effect/cubismeyeblink";
import { ICubismModelSetting } from "@framework/icubismmodelsetting";
import { CubismIdHandle } from "@framework/id/cubismid";
import { CubismFramework } from "@framework/live2dcubismframework";
import { CubismMatrix44 } from "@framework/math/cubismmatrix44";
import { CubismUserModel } from "@framework/model/cubismusermodel";
import {
  ACubismMotion,
  FinishedMotionCallback,
} from "@framework/motion/acubismmotion";
import { CubismMotion } from "@framework/motion/cubismmotion";
import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue,
} from "@framework/motion/cubismmotionqueuemanager";
import { csmMap } from "@framework/type/csmmap";
import { csmRect } from "@framework/type/csmrectf";
import { csmString } from "@framework/type/csmstring";
import { csmVector } from "@framework/type/csmvector";
import {
  CSM_ASSERT,
  CubismLogError,
  CubismLogInfo,
} from "@framework/utils/cubismdebug";

import * as LAppDefine from "./lappdefine";
import { frameBuffer, LAppDelegate } from "./lappdelegate";
import { canvas, gl } from "./lappglmanager";
import { LAppPal } from "./lapppal";
import {
  prepareDirectParameterExecution,
  type DirectParameterExecutionPlan,
  type DirectParameterPlanInput,
  type DirectParameterPlanStartOptions,
  type DirectParameterPlanTerminalEvent,
  type DirectParameterPlanTerminalStatus,
} from "./directparameterplan";
import {
  ActiveParameterMixer,
  type ActiveDirectParameterFrameState,
  type DirectSemanticParameterBinding,
  type ParameterFrameOwner,
} from "./parametermixer";
import {
  SpeechSignalRuntime,
  type ExternalAudioSignalSourceOptions,
  type ExternalAudioSignalValues,
} from "./speechsignalruntime";
import { TextureInfo } from "./lapptexturemanager";
import { CubismMoc } from "@framework/model/cubismmoc";
import {
  cancelLive2DModelLoad,
  getLive2DModelLoadState,
  isLive2DModelLoadActive,
  markLive2DModelFailed,
  markLive2DModelReady,
} from "./modelreadiness";

interface CatalogMotionLifecycleCallbacks {
  playbackClockReader?: { getElapsedMs: () => number | null };
  onStarted?: () => void;
  onFinished?: () => void;
  onFailed?: (reason: string) => void;
  onInterrupted?: (reason: string) => void;
}

enum LoadStep {
  LoadAssets,
  LoadModel,
  WaitLoadModel,
  LoadExpression,
  WaitLoadExpression,
  LoadPhysics,
  WaitLoadPhysics,
  LoadPose,
  WaitLoadPose,
  SetupEyeBlink,
  SetupBreath,
  LoadUserData,
  WaitLoadUserData,
  SetupEyeBlinkIds,
  SetupLipSyncIds,
  SetupLayout,
  LoadMotion,
  WaitLoadMotion,
  CompleteInitialize,
  CompleteSetupModel,
  LoadTexture,
  WaitLoadTexture,
  CompleteSetup,
}

const DIRECT_MAX_MISSING_AXIS_BINDINGS = 3;
const DIRECT_MAX_SUPPLEMENTARY_BINDING_FAILURES = 3;

interface DirectParameterPlanState extends ActiveDirectParameterFrameState {
  /** 本次参数计划的唯一标识符。由 startDirectParameterPlan 生成并回传。 */
  runId: string;
  /** 参数计划完成时的回调。 */
  onTerminal?: (event: DirectParameterPlanTerminalEvent) => void;
  /** Expression resources are owned by the direct plan that started them. */
  expressionId: string | null;
  /** 防止重复发射完成事件 */
  terminalEmitted: boolean;
}

type DirectParameterPlanCandidate =
  | { ok: true; state: DirectParameterPlanState }
  | { ok: false; reason: string };

interface ActiveParameterFrameFailure {
  owner: ParameterFrameOwner;
  reason: string;
}

/**
 * ユーザーが実際に使用するモデルの実装クラス<br>
 * モデル生成、機能コンポーネント生成、更新処理とレンダリングの呼び出しを行う。
 */
export class LAppModel extends CubismUserModel {
  private readonly _loadGeneration = getLive2DModelLoadState().generation;
  private _released = false;
  private _activeCatalogMotionStop: ((reason: string) => void) | null = null;
  private _activeCatalogMotionClockReader: { getElapsedMs: () => number | null } | null = null;
  private _activeCatalogMotionClockElapsedMs: number | null = null;

  private failModelLoad(reason: string, error?: unknown): void {
    if (!this.isLoadActive()) {
      return;
    }
    const details = error instanceof Error ? error.message : String(error ?? "");
    const message = details ? `${reason}:${details}` : reason;
    CubismLogError(message);
    markLive2DModelFailed(this._loadGeneration, message);
  }

  private isLoadActive(): boolean {
    return !this._released && isLive2DModelLoadActive(this._loadGeneration);
  }

  private requireActiveLoad(): void {
    if (!this.isLoadActive()) {
      throw new Error("live2d_model_load_cancelled");
    }
  }

  private async fetchRequiredArrayBuffer(path: string): Promise<ArrayBuffer> {
    this.requireActiveLoad();
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`http_${response.status}:${path}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    this.requireActiveLoad();
    return arrayBuffer;
  }

  private async fetchRuntimeArrayBuffer(path: string): Promise<ArrayBuffer> {
    if (this._released) {
      throw new Error("live2d_model_released");
    }
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`http_${response.status}:${path}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (this._released) {
      throw new Error("live2d_model_released");
    }
    return arrayBuffer;
  }

  public override release(): void {
    if (this._released) {
      return;
    }
    this.stopDirectParameterPlan("direct_parameter_plan_model_released", "failed");
    this.stopMotion("motion_model_released");
    this._speechSignalRuntime.reset();
    this._released = true;
    cancelLive2DModelLoad(this._loadGeneration, "live2d_model_load_released");
    super.release();
  }

  /**
   * model3.jsonが置かれたディレクトリとファイルパスからモデルを生成する
   * @param dir
   * @param fileName
   */
  public loadAssets(dir: string, fileName: string): void {
    this._modelHomeDir = dir;

    this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${fileName}`)
      .then((arrayBuffer) => {
        const setting: ICubismModelSetting = new CubismModelSettingJson(
          arrayBuffer,
          arrayBuffer.byteLength
        );

        // ステートを更新
        this._state = LoadStep.LoadModel;

        // 結果を保存
        this.setupModel(setting);
      })
      .catch((error) => {
        this.failModelLoad(`live2d_model_setting_load_failed:${this._modelHomeDir}${fileName}`, error);
      });
  }

  /**
   * model3.jsonからモデルを生成する。
   * model3.jsonの記述に従ってモデル生成、モーション、物理演算などのコンポーネント生成を行う。
   *
   * @param setting ICubismModelSettingのインスタンス
   */
  private setupModel(setting: ICubismModelSetting): void {
    this._updating = true;
    this._initialized = false;

    this._modelSetting = setting;

    // Log hit areas information
    const hitAreasCount = this._modelSetting.getHitAreasCount();
    console.log(`Model has ${hitAreasCount} hit areas`);

    // CubismModel
    if (this._modelSetting.getModelFileName() != "") {
      const modelFileName = this._modelSetting.getModelFileName();

      this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${modelFileName}`)
        .then((arrayBuffer) => {
          this.loadModel(arrayBuffer, this._mocConsistency, LAppDefine.CurrentKScale);
          this._state = LoadStep.LoadExpression;

          // callback
          loadCubismExpression();
        })
        .catch((error) => this.failModelLoad("live2d_moc_load_failed", error));

      this._state = LoadStep.WaitLoadModel;
    } else {
      LAppPal.printMessage("Model data does not exist.");
    }

    // Expression
    const loadCubismExpression = (): void => {
      if (this._modelSetting.getExpressionCount() > 0) {
        const count: number = this._modelSetting.getExpressionCount();

        for (let i = 0; i < count; i++) {
          const expressionName = this._modelSetting.getExpressionName(i);
          const expressionFileName =
            this._modelSetting.getExpressionFileName(i);

          this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${expressionFileName}`)
            .then((arrayBuffer) => {
              const motion: ACubismMotion = this.loadExpression(
                arrayBuffer,
                arrayBuffer.byteLength,
                expressionName
              );

              if (this._expressions.getValue(expressionName) != null) {
                ACubismMotion.delete(
                  this._expressions.getValue(expressionName)
                );
                this._expressions.setValue(expressionName, null);
              }

              this._expressions.setValue(expressionName, motion);

              this._expressionCount++;

              if (this._expressionCount >= count) {
                this._state = LoadStep.LoadPhysics;

                // callback
                loadCubismPhysics();
              }
            })
            .catch((error) => this.failModelLoad("live2d_expression_load_failed", error));
        }
        this._state = LoadStep.WaitLoadExpression;
      } else {
        this._state = LoadStep.LoadPhysics;

        // callback
        loadCubismPhysics();
      }
    };

    // Physics
    const loadCubismPhysics = (): void => {
      if (this._modelSetting.getPhysicsFileName() != "") {
        const physicsFileName = this._modelSetting.getPhysicsFileName();

        this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${physicsFileName}`)
          .then((arrayBuffer) => {
            this.loadPhysics(arrayBuffer, arrayBuffer.byteLength);
            this._physics?.setTerminalOutputResponseScale(
              LAppDefine.PHYSICS_RESPONSE_SCALE
            );
            this._physics?.setTerminalOutputResponseProtectedParameterIds(
              LAppDefine.PHYSICS_RESPONSE_PROTECTED_PARAMETER_IDS,
            );

            this._state = LoadStep.LoadPose;

            // callback
            loadCubismPose();
          })
          .catch((error) => this.failModelLoad("live2d_physics_load_failed", error));
        this._state = LoadStep.WaitLoadPhysics;
      } else {
        this._state = LoadStep.LoadPose;

        // callback
        loadCubismPose();
      }
    };

    // Pose
    const loadCubismPose = (): void => {
      if (this._modelSetting.getPoseFileName() != "") {
        const poseFileName = this._modelSetting.getPoseFileName();

        this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${poseFileName}`)
          .then((arrayBuffer) => {
            this.loadPose(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlink;

            // callback
            setupEyeBlink();
          })
          .catch((error) => this.failModelLoad("live2d_pose_load_failed", error));
        this._state = LoadStep.WaitLoadPose;
      } else {
        this._state = LoadStep.SetupEyeBlink;

        // callback
        setupEyeBlink();
      }
    };

    // EyeBlink
    const setupEyeBlink = (): void => {
      if (this._modelSetting.getEyeBlinkParameterCount() > 0) {
        this._eyeBlink = CubismEyeBlink.create(this._modelSetting);
        this._state = LoadStep.SetupBreath;
      }

      // callback
      setupBreath();
    };

    // Breath
    const setupBreath = (): void => {
      this._breath = CubismBreath.create();

      const breathParameters: csmVector<BreathParameterData> = new csmVector();
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleX, 0.0, 15.0, 6.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleY, 0.0, 8.0, 3.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleZ, 0.0, 10.0, 5.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamBodyAngleX, 0.0, 4.0, 15.5345, 0.5)
      );

      // Add null check for CubismFramework.getIdManager()
      const idManager = CubismFramework.getIdManager();
      if (idManager) {
        const breathParameterId = idManager.getId(CubismDefaultParameterId.ParamBreath);
        if (breathParameterId) {
          breathParameters.pushBack(
            new BreathParameterData(breathParameterId, 0.5, 0.5, 3.2345, 1)
          );
        }
      }

      this._breath.setParameters(breathParameters);
      this._state = LoadStep.LoadUserData;

      // callback
      loadUserData();
    };

    // UserData
    const loadUserData = (): void => {
      if (this._modelSetting.getUserDataFile() != "") {
        const userDataFile = this._modelSetting.getUserDataFile();

        this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${userDataFile}`)
          .then((arrayBuffer) => {
            this.loadUserData(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlinkIds;

            // callback
            setupEyeBlinkIds();
          })
          .catch((error) => this.failModelLoad("live2d_user_data_load_failed", error));

        this._state = LoadStep.WaitLoadUserData;
      } else {
        this._state = LoadStep.SetupEyeBlinkIds;

        // callback
        setupEyeBlinkIds();
      }
    };

    // EyeBlinkIds
    const setupEyeBlinkIds = (): void => {

      const eyeBlinkIdCount: number =
        this._modelSetting.getEyeBlinkParameterCount();

      for (let i = 0; i < eyeBlinkIdCount; ++i) {
        this._eyeBlinkIds.pushBack(
          this._modelSetting.getEyeBlinkParameterId(i)
        );
      }

      this._state = LoadStep.SetupLipSyncIds;

      // callback
      setupLipSyncIds();
    };

    // LipSyncIds
    const setupLipSyncIds = (): void => {

      const lipSyncIdCount = this._modelSetting.getLipSyncParameterCount();

      for (let i = 0; i < lipSyncIdCount; ++i) {
        this._lipSyncIds.pushBack(this._modelSetting.getLipSyncParameterId(i));
      }

      if (this._lipSyncIds.getSize() === 0) {
        console.error(
          "[LAppModel] model3.json does not declare a LipSync parameter group.",
        );
      }

      this._state = LoadStep.SetupLayout;

      // callback
      setupLayout();
    };

    // Layout
    const setupLayout = (): void => {
      const layout: csmMap<string, number> = new csmMap<string, number>();

      if (this._modelSetting == null || this._modelMatrix == null) {
        CubismLogError("Failed to setupLayout().");
        return;
      }

      this._modelSetting.getLayoutMap(layout);
      this._modelMatrix.setupFromLayout(layout);
      this._state = LoadStep.LoadMotion;

      // callback
      loadCubismMotion();
    };

    // Motion
    const loadCubismMotion = (): void => {
      this._state = LoadStep.WaitLoadMotion;
      this._model.saveParameters();
      this._allMotionCount = 0;
      this._motionCount = 0;
      const group: string[] = [];

      const motionGroupCount: number = this._modelSetting.getMotionGroupCount();

      // モーションの総数を求める
      for (let i = 0; i < motionGroupCount; i++) {
        group[i] = this._modelSetting.getMotionGroupName(i);
        this._allMotionCount += this._modelSetting.getMotionCount(group[i]);
      }

      // Check if there are no actual motions to load, even if groups exist
      if (this._allMotionCount == 0) {
        this._state = LoadStep.LoadTexture;

        // 全てのモーションを停止する
        this._motionManager.stopAllMotions();

        this._updating = false;
        this._initialized = true;

        this.createRenderer();
        this.setupTextures();
        this.getRenderer().startUp(gl);
        return;
      }

      // モーションの読み込み
      for (let i = 0; i < motionGroupCount; i++) {
        this.preLoadMotionGroup(group[i]);
      }

      // モーションがない場合 (Original check, now might be redundant but kept for safety)
      if (motionGroupCount == 0) {
        this._state = LoadStep.LoadTexture;

        // 全てのモーションを停止する
        this._motionManager.stopAllMotions();

        this._updating = false;
        this._initialized = true;

        this.createRenderer();
        this.setupTextures();
        this.getRenderer().startUp(gl);
      }
    };
  }

  /**
   * テクスチャのセットアップ
   */
  private setupTextures(): void {
    console.log('Setting up textures for model:', this._modelHomeDir);

    // iPhoneでのアルファ品質向上のためTypescriptではpremultipliedAlphaを採用 (Reverted to likely original)
    const usePremultiply = true;

    if (this._state == LoadStep.LoadTexture) {
      // テクスチャ読み込み用
      const textureCount: number = this._modelSetting.getTextureCount();

      for (
        let modelTextureNumber = 0;
        modelTextureNumber < textureCount;
        modelTextureNumber++
      ) {
        // テクスチャ名が空文字だった場合はロード・バインド処理をスキップ
        if (this._modelSetting.getTextureFileName(modelTextureNumber) == "") {
          this.failModelLoad(`live2d_texture_name_empty:${modelTextureNumber}`);
          return;
        }

        // WebGLのテクスチャユニットにテクスチャをロードする
        let texturePath =
          this._modelSetting.getTextureFileName(modelTextureNumber);
        texturePath = this._modelHomeDir + texturePath;

        // ロード完了時に呼び出すコールバック関数
        const onLoad = (textureInfo: TextureInfo): void => {
          if (!this.isLoadActive()) {
            return;
          }
          this.getRenderer().bindTexture(modelTextureNumber, textureInfo.id);

          this._textureCount++;

          if (this._textureCount >= textureCount) {
            // ロード完了
            this._state = LoadStep.CompleteSetup;
            markLive2DModelReady(this._loadGeneration);
          }
        };

        // 読み込み
        LAppDelegate.getInstance()
          .getTextureManager()
          .createTextureFromPngFile(
            texturePath,
            usePremultiply,
            onLoad,
            (error) => this.failModelLoad(`live2d_texture_load_failed:${texturePath}`, error),
          );
        this.getRenderer().setIsPremultipliedAlpha(usePremultiply);
      }

      this._state = LoadStep.WaitLoadTexture;

      if (textureCount === 0) {
        this._state = LoadStep.CompleteSetup;
        markLive2DModelReady(this._loadGeneration);
      }
    }
  }

  /**
   * レンダラを再構築する
   */
  public reloadRenderer(): void {
    this.deleteRenderer();
    this.createRenderer();
    this.setupTextures();
  }

  /**
   * 更新
   */
  public update(): void {
    if (this._state != LoadStep.CompleteSetup) return;

    const deltaTimeSeconds: number = LAppPal.getDeltaTime();
    this._userTimeSeconds += deltaTimeSeconds;
    const ambientMotionEnabled = LAppDefine.AMBIENT_MOTION_ENABLED;

    this._dragManager.update(deltaTimeSeconds);
    this._dragX = this._dragManager.getX();
    this._dragY = this._dragManager.getY();
    const audioSignals = this._speechSignalRuntime.advanceFrame(
      deltaTimeSeconds,
      this._lipsync === true,
    );

    // モーションによるパラメータ更新の有無
    let motionUpdated = false;

    //--------------------------------------------------------------------------
    this._model.loadParameters(); // 前回セーブされた状態をロード
    if (this._motionManager.isFinished()) {
      // モーションの再生がない場合、待機モーションの中からランダムで再生する
      if (ambientMotionEnabled) {
        this.startRandomMotion(
          LAppDefine.MotionGroupIdle,
          LAppDefine.PriorityIdle
        );
      }
    } else {
      const motionDeltaTimeSeconds = this.resolveCatalogMotionDeltaTime(
        deltaTimeSeconds,
      );
      motionUpdated = this._motionManager.updateMotion(
        this._model,
        motionDeltaTimeSeconds
      ); // モーションを更新
    }
    this._model.saveParameters(); // 状態を保存
    //--------------------------------------------------------------------------

    // まばたき
    if (ambientMotionEnabled && !motionUpdated) {
      if (this._eyeBlink != null) {
        // メインモーションの更新がないとき
        this._eyeBlink.updateParameters(this._model, deltaTimeSeconds); // 目パチ
      }
    }

    if (this._expressionManager != null) {
      this._expressionManager.updateMotion(this._model, deltaTimeSeconds); // 表情でパラメータ更新（相対変化）
    }

    // ドラッグによる変化
    // ドラッグによる顔の向きの調整
    this._model.addParameterValueById(this._idParamAngleX, this._dragX * 30); // -30から30の値を加える
    this._model.addParameterValueById(this._idParamAngleY, this._dragY * 30);
    this._model.addParameterValueById(
      this._idParamAngleZ,
      this._dragX * this._dragY * -30
    );

    // ドラッグによる体の向きの調整
    this._model.addParameterValueById(
      this._idParamBodyAngleX,
      this._dragX * 10
    ); // -10から10の値を加える

    // ドラッグによる目の向きの調整
    this._model.addParameterValueById(this._idParamEyeBallX, this._dragX); // -1から1の値を加える
    this._model.addParameterValueById(this._idParamEyeBallY, this._dragY);

    // 呼吸など
    if (ambientMotionEnabled && this._breath != null) {
      this._breath.updateParameters(this._model, deltaTimeSeconds);
    }

    // All AG99 active parameters are resolved once before Physics consumes them.
    let parameterMixerFailure: ActiveParameterFrameFailure | null = null;
    try {
      parameterMixerFailure = this.applyActiveParameterFrame(
        audioSignals.lipSyncIntensity,
        audioSignals.lipSyncActive,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parameterMixerFailure = {
        owner: "mixed",
        reason: `parameter_mixer_frame_exception:${message || "unknown_error"}`,
      };
      console.error("[LAppModel] Active parameter frame execution failed.", error);
    }
    if (parameterMixerFailure) {
      console.error("[LAppModel] Active parameter frame rejected.", {
        owner: parameterMixerFailure.owner,
        reason: parameterMixerFailure.reason,
      });
      if (
        parameterMixerFailure.owner !== "lip_sync"
        && this.hasActiveDirectParameterPlan()
      ) {
        this.stopDirectParameterPlan(parameterMixerFailure.reason, "failed");
      }
      if (parameterMixerFailure.owner !== "direct_plan") {
        this._speechSignalRuntime.failActiveSource(parameterMixerFailure.reason);
      }
    }

    // 物理演算の設定
    if (this._physics != null) {
      this._physics.evaluate(this._model, deltaTimeSeconds);
    }

    // ポーズの設定
    if (this._pose != null) {
      this._pose.updateParameters(this._model, deltaTimeSeconds);
    }

    this._model.update();
  }

  public setPhysicsResponseScale(scale: number): void {
    this._physics?.setTerminalOutputResponseScale(scale);
  }

  public setPhysicsResponseProtectedParameterIds(
    parameterIds: readonly string[],
  ): void {
    this._physics?.setTerminalOutputResponseProtectedParameterIds(parameterIds);
  }

  public stopAmbientMotion(): void {
    const isIdleMotion =
      this._motionManager.getCurrentPriority() === LAppDefine.PriorityIdle
      || this._motionManager.getReservePriority() === LAppDefine.PriorityIdle;
    if (isIdleMotion) {
      this.stopMotion("ambient_motion_disabled");
    }
  }

  public stopMotion(reason = "motion_stopped"): void {
    const activeStop = this._activeCatalogMotionStop;
    this._activeCatalogMotionStop = null;
    this._activeCatalogMotionClockReader = null;
    this._activeCatalogMotionClockElapsedMs = null;
    activeStop?.(reason);
    this._motionManager.stopAllMotions();
    this._motionManager.setReservePriority(0);
  }

  /**
   * 引数で指定したモーションの再生を開始する
   * @param group モーショングループ名
   * @param no グループ内の番号
   * @param priority 優先度
   * @param onFinishedMotionHandler モーション再生終了時に呼び出されるコールバック関数
   * @return 開始したモーションの識別番号を返す。個別のモーションが終了したか否かを判定するisFinished()の引数で使用する。開始できない時は[-1]
   */
  public startMotion(
    group: string,
    no: number,
    priority: number,
    callbacks?: CatalogMotionLifecycleCallbacks | FinishedMotionCallback
  ): CubismMotionQueueEntryHandle {
    const lifecycleCallbacks = typeof callbacks === "function"
      ? { onFinished: callbacks }
      : callbacks;
    let terminalSettled = false;
    let activeStop: ((reason: string) => void) | null = null;
    const clearOwnedCatalogMotionState = () => {
      if (!activeStop || this._activeCatalogMotionStop !== activeStop) {
        return;
      }
      this._activeCatalogMotionStop = null;
      this.clearCatalogMotionClock();
    };
    const finish = () => {
      if (terminalSettled) {
        return;
      }
      terminalSettled = true;
      clearOwnedCatalogMotionState();
      lifecycleCallbacks?.onFinished?.();
    };
    const fail = (reason: string) => {
      if (terminalSettled) {
        return;
      }
      terminalSettled = true;
      clearOwnedCatalogMotionState();
      lifecycleCallbacks?.onFailed?.(reason);
    };
    const start = () => {
      if (terminalSettled) {
        return;
      }
      const clockReader = lifecycleCallbacks?.playbackClockReader;
      if (clockReader) {
        const elapsedMs = clockReader.getElapsedMs();
        if (elapsedMs === null || !Number.isFinite(elapsedMs)) {
          fail("catalog_motion_clock_unavailable");
          this._motionManager.stopAllMotions();
          this._motionManager.setReservePriority(0);
          return;
        }
        this._activeCatalogMotionClockReader = clockReader;
        this._activeCatalogMotionClockElapsedMs = elapsedMs;
      }
      lifecycleCallbacks?.onStarted?.();
    };
    this._motionStartError = "";
    if (this._released) {
      this._motionStartError = "motion_model_released";
      fail(this._motionStartError);
      return InvalidMotionQueueEntryHandleValue;
    }
    if (!this._model || !this._motionManager || this._state !== LoadStep.CompleteSetup) {
      this._motionStartError = "motion_model_not_ready";
      fail(this._motionStartError);
      return InvalidMotionQueueEntryHandleValue;
    }
    const requestedClockReader = lifecycleCallbacks?.playbackClockReader;
    if (requestedClockReader) {
      const elapsedMs = requestedClockReader.getElapsedMs();
      if (elapsedMs === null || !Number.isFinite(elapsedMs)) {
        this._motionStartError = "catalog_motion_clock_unavailable";
        fail(this._motionStartError);
        return InvalidMotionQueueEntryHandleValue;
      }
    }

    const name = `${group}_${no}`;
    const motion = this._motions.getValue(name) as CubismMotion;
    if (motion == null) {
      this._motionStartError = `motion_not_loaded:${name}`;
      fail(this._motionStartError);
      return InvalidMotionQueueEntryHandleValue;
    }

    // Add a log specifically when trying to start a tap motion (which uses priority 3)
    if (priority === 3 && LAppDefine.DebugLogEnable) {
      console.log(`[APP] startMotion: Attempting to start tap motion. Group: '${group}', Index: ${no}`);
    }

    if (priority == LAppDefine.PriorityForce) {
      this._motionManager.setReservePriority(priority);
    } else if (!this._motionManager.reserveMotion(priority)) {
      if (this._debugMode) {
        LAppPal.printMessage("[APP]can't start motion.");
      }
      this._motionStartError = "motion_priority_rejected";
      fail(this._motionStartError);
      return InvalidMotionQueueEntryHandleValue;
    }

    const previousActiveStop = this._activeCatalogMotionStop;
    previousActiveStop?.("motion_replaced");
    activeStop = (reason: string) => {
      if (terminalSettled) {
        return;
      }
      terminalSettled = true;
      clearOwnedCatalogMotionState();
      lifecycleCallbacks?.onInterrupted?.(reason);
    };
    this._activeCatalogMotionStop = activeStop;

    if (LAppDefine.DebugLogEnable) {
      console.log(`[APP] startMotion: Starting preloaded motion '${name}'.`);
    }
    motion.setFinishedMotionHandler(finish);
    const handle = this._motionManager.startMotionPriority(
      motion,
      false,
      priority,
    );
    if (handle === InvalidMotionQueueEntryHandleValue) {
      this._motionStartError = "motion_start_rejected";
      if (this._motionManager.getReservePriority() === priority) {
        this._motionManager.setReservePriority(0);
      }
      fail(this._motionStartError);
    } else {
      start();
    }
    return handle;
  }

  public getMotionStartError(): string {
    return this._motionStartError || "";
  }

  /**
   * ランダムに選ばれたモーションの再生を開始する。
   * @param group モーショングループ名
   * @param priority 優先度
   * @param onFinishedMotionHandler モーション再生終了時に呼び出されるコールバック関数
   * @return 開始したモーションの識別番号を返す。個別のモーションが終了したか否かを判定するisFinished()の引数で使用する。開始できない時は[-1]
   */
  public startRandomMotion(
    group: string,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback
  ): CubismMotionQueueEntryHandle {
    if (LAppDefine.DebugLogEnable) {
      console.log(`[APP] startRandomMotion called. Group: '${group}', Priority: ${priority}`);
    }
    if (this._modelSetting.getMotionCount(group) == 0) {
      if (LAppDefine.DebugLogEnable) {
         console.warn(`[APP] startRandomMotion: No motions found in group '${group}'`);
      }
      return InvalidMotionQueueEntryHandleValue;
    }

    const no: number = Math.floor(
      Math.random() * this._modelSetting.getMotionCount(group)
    );

    if (LAppDefine.DebugLogEnable) {
      console.log(`[APP] startRandomMotion: Selected random index ${no} from group '${group}'`);
    }

    return this.startMotion(group, no, priority, onFinishedMotionHandler);
  }

  /**
   * 引数で指定した表情モーションをセットする
   *
   * @param expressionId 表情モーションのID
   */
  public setExpression(expressionId: string): boolean {
    this._expressionStartError = '';
    const motion: ACubismMotion = this._expressions.getValue(expressionId);

    if (this._debugMode) {
      LAppPal.printMessage(`[APP]expression: [${expressionId}]`);
    }

    if (motion != null) {
      const handle = this._expressionManager.startMotionPriority(
        motion,
        false,
        LAppDefine.PriorityForce
      );
      if (handle === InvalidMotionQueueEntryHandleValue) {
        this._expressionStartError = 'expression_start_rejected';
        return false;
      }
      return true;
    } else {
      this._expressionStartError = 'expression_not_found';
      if (this._debugMode) {
        LAppPal.printMessage(`[APP]expression[${expressionId}] is null`);
      }
      return false;
    }
  }

  private resolveCatalogMotionDeltaTime(renderDeltaTimeSeconds: number): number {
    const reader = this._activeCatalogMotionClockReader;
    if (!reader) {
      return renderDeltaTimeSeconds;
    }
    const elapsedMs = reader.getElapsedMs();
    if (elapsedMs === null || !Number.isFinite(elapsedMs)) {
      this.stopMotion("catalog_motion_clock_unavailable");
      return 0;
    }
    const previousElapsedMs = this._activeCatalogMotionClockElapsedMs ?? elapsedMs;
    this._activeCatalogMotionClockElapsedMs = elapsedMs;
    return Math.max(0, (elapsedMs - previousElapsedMs) / 1000);
  }

  private clearCatalogMotionClock(): void {
    this._activeCatalogMotionClockReader = null;
    this._activeCatalogMotionClockElapsedMs = null;
  }

  public stopExpression(): void {
    this._expressionManager.fadeOutAllMotions();
  }

  public getExpressionStartError(): string {
    return this._expressionStartError;
  }

  /**
   * ランダムに選ばれた表情モーションをセットする
   */
  public setRandomExpression(): void {
    if (this._expressions.getSize() == 0) {
      return;
    }

    const no: number = Math.floor(Math.random() * this._expressions.getSize());

    for (let i = 0; i < this._expressions.getSize(); i++) {
      if (i == no) {
        const name: string = this._expressions._keyValues[i].first;
        this.setExpression(name);
        return;
      }
    }
  }

  /**
   * イベントの発火を受け取る
   */
  public motionEventFired(eventValue: csmString): void {
    CubismLogInfo("{0} is fired on LAppModel!!", eventValue.s);
  }

  /**
   * 当たり判定テスト
   * 指定ＩＤの頂点リストから矩形を計算し、座標をが矩形範囲内か判定する。
   *
   * @param hitArenaName  当たり判定をテストする対象のID
   * @param x             判定を行うX座標
   * @param y             判定を行うY座標
   */
  public hitTest(hitArenaName: string, x: number, y: number): boolean {
    // 透明時は当たり判定無し。
    if (this._opacity < 1) {
      return false;
    }

    const count: number = this._modelSetting.getHitAreasCount();

    for (let i = 0; i < count; i++) {
      if (this._modelSetting.getHitAreaName(i) == hitArenaName) {
        const drawId: CubismIdHandle = this._modelSetting.getHitAreaId(i);
        return this.isHit(drawId, x, y);
      }
    }

    return false;
  }

  /**
   * Test if a point hits any part of the model's defined hit areas.
   * @param x X coordinate to test
   * @param y Y coordinate to test
   * @returns The name of the hit area if hit, otherwise null.
   */
  public anyhitTest(x: number, y: number): string | null {
    // If opacity is less than 1, no hit detection
    if (this._opacity < 1) {
      return null;
    }

    const count: number = this._modelSetting.getHitAreasCount();

    for (let i = 0; i < count; i++) {
      const drawId: CubismIdHandle = this._modelSetting.getHitAreaId(i);
      const hit = this.isHit(drawId, x, y);
      if (hit) {
        // Get the CubismIdHandle for the hit area
        const hitAreaIdHandle = this._modelSetting.getHitAreaId(i);
        
        // Attempt to access the string via the internal _id.s structure
        // Accessing private members like this is generally discouraged but necessary if no public API exists
        const idString = (hitAreaIdHandle as any)?._id?.s; // Cast to any to bypass potential type errors

        // Debug log for hit area detection
        if (LAppDefine.DebugLogEnable) {
          console.log(`[APP] anyhitTest: Hit detected. ID Handle:`, hitAreaIdHandle, ` Extracted ID String: ${idString}`);
        }
        // Return the ID string which should match the tapMotions keys
        return idString || null; // Return the extracted string, or null if it failed
      }
    }
    // Debug log if no hit area detected
    if (LAppDefine.DebugLogEnable) {
       // console.log(`[APP] anyhitTest: No specific hit area detected.`);
    }
    return null; // No hit area was hit
  }

  /**
   * Load motions for the model
   * @param group Motion group name
   */
  public preLoadMotionGroup(group: string): void {
    for (let i = 0; i < this._modelSetting.getMotionCount(group); i++) {
      const motionFileName = this._modelSetting.getMotionFileName(group, i);

      // ex) idle_0
      const name = `${group}_${i}`;
      if (this._debugMode) {
        LAppPal.printMessage(
          `[APP]load motion: ${motionFileName} => [${name}]`
        );
      }

      this.fetchRequiredArrayBuffer(`${this._modelHomeDir}${motionFileName}`)
        .then((arrayBuffer) => {
          const tmpMotion: CubismMotion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            name
          );

          if (tmpMotion == null) {
            throw new Error(`Failed to decode motion ${motionFileName}`);
          }

          let fadeTime = this._modelSetting.getMotionFadeInTimeValue(
            group,
            i
          );
          if (fadeTime >= 0.0) {
            tmpMotion.setFadeInTime(fadeTime);
          }

          fadeTime = this._modelSetting.getMotionFadeOutTimeValue(group, i);
          if (fadeTime >= 0.0) {
            tmpMotion.setFadeOutTime(fadeTime);
          }
          tmpMotion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);

          if (this._motions.getValue(name) != null) {
            ACubismMotion.delete(this._motions.getValue(name));
          }

          this._motions.setValue(name, tmpMotion);

          this._motionCount++;
          this.completeMotionLoadingIfReady();
        })
        .catch((error) => {
          this._updating = false;
          this._initialized = false;
          this.failModelLoad("live2d_motion_load_failed", error);
        });
    }
  }

  private completeMotionLoadingIfReady(): void {
    if (
      this._state !== LoadStep.WaitLoadMotion
      && this._state !== LoadStep.LoadMotion
    ) {
      return;
    }

    if (this._motionCount < this._allMotionCount) {
      return;
    }

    this._state = LoadStep.LoadTexture;

    // 全てのモーションを停止する
    this._motionManager.stopAllMotions();

    this._updating = false;
    this._initialized = true;

    this.createRenderer();
    this.setupTextures();
    this.getRenderer().startUp(gl);
  }

  /**
   * すべてのモーションデータを解放する。
   */
  public releaseMotions(): void {
    this._motions.clear();
  }

  /**
   * 全ての表情データを解放する。
   */
  public releaseExpressions(): void {
    this._expressions.clear();
  }

  /**
   * モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
   */
  public doDraw(): void {
    if (this._model == null) return;

    // キャンバスサイズを渡す
    const viewport: number[] = [0, 0, canvas.width, canvas.height];

    this.getRenderer().setRenderState(frameBuffer, viewport);
    this.getRenderer().drawModel();
  }

  /**
   * モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
   */
  public draw(matrix: CubismMatrix44): void {
    if (this._model == null) {
      return;
    }

    // 各読み込み終了後
    if (this._state == LoadStep.CompleteSetup) {
      matrix.multiplyByMatrix(this._modelMatrix);

      this.getRenderer().setMvpMatrix(matrix);

      this.doDraw();
    }
  }

  public async hasMocConsistencyFromFile() {
    CSM_ASSERT(this._modelSetting.getModelFileName().localeCompare(``));

    // CubismModel
    if (this._modelSetting.getModelFileName() != "") {
      const modelFileName = this._modelSetting.getModelFileName();

      const response = await fetch(`${this._modelHomeDir}${modelFileName}`);
      const arrayBuffer = await response.arrayBuffer();

      this._consistency = CubismMoc.hasMocConsistency(arrayBuffer);

      if (!this._consistency) {
        CubismLogInfo("Inconsistent MOC3.");
      } else {
        CubismLogInfo("Consistent MOC3.");
      }

      return this._consistency;
    } else {
      LAppPal.printMessage("Model data does not exist.");
    }
  }

  /**
   * Test if a point hits the model's rendered area
   * This is a fallback method when no hit areas are defined
   * @param x X coordinate to test
   * @param y Y coordinate to test
   */
  public isHitOnModel(x: number, y: number): boolean {
    // Skip if model is transparent
    if (this._opacity < 1) {
      return false;
    }

    // Get drawable count
    const drawableCount = this._model.getDrawableCount();
    
    // Get model matrix
    const matrix = this._modelMatrix.getArray();
    
    // Calculate determinant
    const det = 
      matrix[0] * matrix[5] - 
      matrix[1] * matrix[4];
    
    if (Math.abs(det) < 0.0001) {
      return false; // Matrix is not invertible
    }

    // Calculate inverse matrix elements
    const invDet = 1.0 / det;
    const invMatrix = {
      a: matrix[5] * invDet,
      b: -matrix[1] * invDet,
      c: -matrix[4] * invDet,
      d: matrix[0] * invDet,
      tx: (matrix[4] * matrix[13] - matrix[5] * matrix[12]) * invDet,
      ty: (matrix[1] * matrix[12] - matrix[0] * matrix[13]) * invDet
    };
    
    // Transform point
    const transformedPoint = {
      x: x * invMatrix.a + y * invMatrix.c + invMatrix.tx,
      y: x * invMatrix.b + y * invMatrix.d + invMatrix.ty
    };

    // Check each drawable area
    for (let i = 0; i < drawableCount; i++) {
      // Skip if drawable is not visible
      if (!this._model.getDrawableDynamicFlagIsVisible(i)) {
        continue;
      }

      // Get drawable vertex positions
      const vertices = this._model.getDrawableVertices(i);
      
      // Calculate bounds
      let minX = vertices[0];
      let minY = vertices[1];
      let maxX = vertices[0];
      let maxY = vertices[1];

      for (let j = 2; j < vertices.length; j += 2) {
        const vx = vertices[j];
        const vy = vertices[j + 1];
        minX = Math.min(minX, vx);
        minY = Math.min(minY, vy);
        maxX = Math.max(maxX, vx);
        maxY = Math.max(maxY, vy);
      }

      // Check if point is inside bounds
      if (
        transformedPoint.x >= minX &&
        transformedPoint.x <= maxX &&
        transformedPoint.y >= minY &&
        transformedPoint.y <= maxY
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Performs a hit test with fallback if the first one fails.
   * 
   * @param x - X coordinate to test
   * @param y - Y coordinate to test
   * @returns boolean indicating if any hit was detected
   */
  public anyHitTestWithFallback(x: number, y: number): boolean {
    // First check named hit areas
    const hitAreaName = this.anyhitTest(x, y);
    
    // If a hit area was found, return true, otherwise fall back to general hit test
    return hitAreaName !== null || this.isHitOnModel(x, y);
  }

  /**
   * Starts a tap motion based on the hit area and configuration.
   * @param hitAreaName The name of the hit area that was tapped, or null if no specific area was hit
   * @param tapMotionsConfig The tap motion configuration from modelInfo
   */
  public startTapMotion(hitAreaName: string | null, tapMotionsConfig: any): void {
    if (LAppDefine.DebugLogEnable) {
      console.log(`[APP] startTapMotion called. Hit area: ${hitAreaName}`);
    }

    if (!tapMotionsConfig || Object.keys(tapMotionsConfig).length === 0) {
      if (LAppDefine.DebugLogEnable) {
        console.log('[APP] No tap motions configured.');
      }
      return;
    }

    let motionsToConsider: { [key: string]: number } = {};
    let areaSpecificHit = false;

    // 1. Check if a specific, configured hit area was tapped
    if (hitAreaName && tapMotionsConfig[hitAreaName]) {
      motionsToConsider = tapMotionsConfig[hitAreaName];
      areaSpecificHit = true;
      if (LAppDefine.DebugLogEnable) {
        console.log(`[APP] startTapMotion: Using motions for specific area: ${hitAreaName}`, motionsToConsider);
      }
    }

    // 2. If no specific area hit OR the hit area has no config, combine all motions with weight summation
    if (!areaSpecificHit) {
      motionsToConsider = {};
      Object.values(tapMotionsConfig).forEach((areaMotions: any) => {
        for (const [motionName, weight] of Object.entries(areaMotions)) {
          if (motionsToConsider[motionName]) {
            motionsToConsider[motionName] += Number(weight);
          } else {
            motionsToConsider[motionName] = Number(weight);
          }
        }
      });
      if (LAppDefine.DebugLogEnable) {
        console.log('[APP] startTapMotion: Using combined motions:', motionsToConsider);
      }
    }

    // 3. Check if there are any motions to play
    if (Object.keys(motionsToConsider).length === 0) {
      if (LAppDefine.DebugLogEnable) {
        console.log('[APP] startTapMotion: No motions found to consider.');
      }
      return;
    }

    // 4. Weighted random selection
    const motionGroups = Object.keys(motionsToConsider);
    const weights = Object.values(motionsToConsider).map(Number);
    const totalWeight = weights.reduce((sum, w) => sum + (isNaN(w) ? 0 : w), 0);

    if (LAppDefine.DebugLogEnable) {
      console.log(`[APP] startTapMotion: Motion groups: ${motionGroups}, Weights: ${weights}, Total weight: ${totalWeight}`);
    }

    if (totalWeight <= 0) {
      if (LAppDefine.DebugLogEnable) {
        console.log('[APP] startTapMotion: Total weight is zero or invalid.');
      }
      return;
    }

    let random = Math.random() * totalWeight;
    let selectedGroupName: string | null = null;

    for (let i = 0; i < motionGroups.length; i++) {
      const weight = isNaN(weights[i]) ? 0 : weights[i];
      if (random < weight) {
        selectedGroupName = motionGroups[i];
        break;
      }
      random -= weight;
    }

    if (LAppDefine.DebugLogEnable) {
      console.log(`[APP] startTapMotion: Selected group: ${selectedGroupName}`);
    }

    // 5. Play the selected motion group
    if (selectedGroupName !== null) {
      // Use PriorityForce (3) to ensure the motion plays
      this.startRandomMotion(selectedGroupName, 3);
    } else {
      if (LAppDefine.DebugLogEnable) {
        console.log('[APP] startTapMotion: Could not select a motion group.');
      }
    }
  }

  public startDirectParameterPlan(
    plan: DirectParameterPlanInput,
    options: DirectParameterPlanStartOptions = {},
  ): boolean {
    const execution = prepareDirectParameterExecution(plan);
    console.info("[LAppModel] starting validated plan. mode=", plan.mode, "emotion=", plan.emotion_label);

    if (!this._model || this._state != LoadStep.CompleteSetup) {
      console.warn("[LAppModel] model not ready. _state=", this._state);
      this._directParameterPlanError = "model_not_ready";
      return false;
    }

    const runId = typeof options.runId === "string" && options.runId.trim()
      ? options.runId.trim()
      : `direct-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const onTerminal = typeof options.onTerminal === "function"
      ? options.onTerminal
      : undefined;
    const playbackClockReader = options.playbackClockReader;
    if (!playbackClockReader || typeof playbackClockReader.getElapsedMs !== "function") {
      this._directParameterPlanError = "parameter_plan_clock_missing";
      return false;
    }

    const candidate = this.buildDirectParameterPlanState(
      execution,
      runId,
      onTerminal,
      playbackClockReader,
    );
    if (!candidate.ok) {
      this._directParameterPlanError = candidate.reason;
      return false;
    }

    const expressionId = candidate.state.expressionId;
    if (expressionId && !this.setExpression(expressionId)) {
      this._directParameterPlanError = this.getExpressionStartError()
        || `expression_start_failed:${expressionId}`;
      return false;
    }

    const previousState = this._directParameterPlanState;
    this._directParameterPlanState = null;
    if (previousState?.expressionId && !expressionId) {
      this.stopExpression();
    }
    if (previousState) {
      // The candidate expression is already active. The replaced plan must not stop it.
      this.emitDirectParameterPlanTerminal(
        previousState,
        "direct_parameter_plan_replaced",
        "stopped",
        false,
      );
    }

    this._directParameterPlanState = candidate.state;
    this._directParameterPlanError = "";
    return true;
  }

  public stopDirectParameterPlan(
    reason = "",
    status: DirectParameterPlanTerminalStatus = "stopped",
  ): void {
    const state = this._directParameterPlanState;
    this._directParameterPlanState = null;
    this._directParameterPlanError = reason ? String(reason) : "";
    if (this._directParameterPlanError) {
      console.error(`[APP] Direct parameter plan stopped: ${this._directParameterPlanError}`);
    }
    if (state) {
      this.emitDirectParameterPlanTerminal(state, reason, status, true);
    }
  }

  public getDirectParameterPlanError(): string {
    return this._directParameterPlanError || "";
  }

  public hasActiveDirectParameterPlan(): boolean {
    return this._directParameterPlanState !== null;
  }

  private buildDirectParameterPlanState(
    parsed: DirectParameterExecutionPlan,
    runId: string,
    onTerminal: DirectParameterPlanState["onTerminal"],
    playbackClockReader: { getElapsedMs: () => number | null },
  ): DirectParameterPlanCandidate {
    const semanticBindings: DirectSemanticParameterBinding[] = [];
    const seenParameterIndices = new Set<number>();

    for (const [index, item] of parsed.plan.parameters.entries()) {
      const parameterIdRaw = String(item.parameter_id || "").trim();
      const axisId = String(item.axis_id || "").trim();
      const parameterIndex = this.resolveWritableParameterIndex(parameterIdRaw);
      if (parameterIndex === null) {
        return {
          ok: false,
          reason: `parameter_plan_missing_runtime_parameter:${axisId}:${parameterIdRaw || index}`,
        };
      }
      if (seenParameterIndices.has(parameterIndex)) {
        return {
          ok: false,
          reason: `parameter_plan_duplicate_runtime_parameter:${axisId}:${parameterIdRaw}`,
        };
      }
      const minValue = this._model.getParameterMinimumValue(parameterIndex);
      const maxValue = this._model.getParameterMaximumValue(parameterIndex);
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        return { ok: false, reason: `parameter_plan_invalid_runtime_range:${parameterIdRaw}` };
      }
      const targetValue = Number(item.target_value);
      if (targetValue < minValue || targetValue > maxValue) {
        return { ok: false, reason: `parameter_plan_target_out_of_runtime_range:${parameterIdRaw}` };
      }
      const neutralTargetValue = Number(item.neutral_target_value);
      if (neutralTargetValue < minValue || neutralTargetValue > maxValue) {
        return { ok: false, reason: `parameter_plan_neutral_out_of_runtime_range:${parameterIdRaw}` };
      }
      const keyframes = Array.isArray(item.keyframes)
        ? item.keyframes.map((keyframe) => ({
            atMs: Number(keyframe.at_ms),
            transitionMs: Number(keyframe.transition_ms),
            value: Number(keyframe.target_value),
          }))
        : [];
      if (keyframes.some((keyframe) => keyframe.value < minValue || keyframe.value > maxValue)) {
        return { ok: false, reason: `parameter_plan_keyframe_out_of_runtime_range:${parameterIdRaw}` };
      }
      seenParameterIndices.add(parameterIndex);
      semanticBindings.push({
        axisId,
        parameterIdRaw,
        targetValue,
        neutralTargetValue,
        weight: Number(item.weight),
        keyframes,
        modulationAmplitude: 0,
        modulationDirection: 1,
        modulationDelayMs: 0,
        modulationPoints: [],
        modulation: item.modulation && typeof item.modulation === "object"
          ? {
            kind: String(item.modulation.kind || "").trim(),
            preset: String(item.modulation.preset || "").trim(),
            amplitude: Number.isFinite(item.modulation.amplitude)
              ? Number(item.modulation.amplitude)
              : null,
            direction: item.modulation.direction === -1 ? -1 : 1,
            delayMs: Number.isFinite(item.modulation.delay_ms)
              ? Number(item.modulation.delay_ms)
              : null,
            points: Array.isArray(item.modulation.points)
              ? item.modulation.points.map((point) => ({
                atMs: Number(point.at_ms),
                transitionMs: Number(point.transition_ms),
                value: Number(point.value),
              }))
              : [],
          }
          : null,
        maxSpeechOffset: Number(item.dynamics.max_speech_offset),
        parameterIndex,
        presentation: {
          parameterId: parameterIdRaw,
          initialValue: this._model.getParameterValueByIndex(parameterIndex),
          neutralValue: neutralTargetValue,
          maxVelocity: Number(item.dynamics.max_velocity),
          maxAcceleration: Number(item.dynamics.max_acceleration),
          response: item.dynamics.response,
          drivenValue: null,
          velocity: 0,
          lastElapsedMs: null,
        },
      });
    }

    if (semanticBindings.length === 0) {
      return { ok: false, reason: "parameter_plan_parameters_empty_after_runtime_filter" };
    }

    for (const item of semanticBindings) {
      if (item.modulation) {
        const modulation = this.resolveSpeechPoseModulation(item);
        item.modulationAmplitude = modulation.amplitude;
        item.modulationDirection = modulation.direction;
        item.modulationDelayMs = modulation.delayMs;
        item.modulationPoints = modulation.points;
      }
    }

    const expressionId = parsed.plan.resource?.kind === "expression"
      ? String(parsed.plan.resource.expression_id || "").trim()
      : "";
    if (expressionId && this._expressions.getValue(expressionId) == null) {
      return { ok: false, reason: `expression_not_found:${expressionId}` };
    }

    console.info("[LAppModel] Semantic parameter bindings ready. Activating parameter plan.", {
      parameterCount: semanticBindings.length,
      profileId: parsed.plan.profile_id,
      profileRevision: parsed.plan.profile_revision,
    });
    return {
      ok: true,
      state: {
      mode: parsed.plan.mode,
      emotionLabel: parsed.plan.emotion_label,
      timing: parsed.timing,
      semanticBindings,
      playbackClockReader,
      diagnosticFrameCount: 0,
      runId: runId || ('direct-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
      onTerminal: onTerminal,
      expressionId: expressionId || null,
      terminalEmitted: false,
      },
    };
  }

  private emitDirectParameterPlanTerminal(
    state: DirectParameterPlanState,
    reason: string,
    status: "completed" | "stopped" | "failed" | "rejected",
    stopOwnedExpression: boolean,
  ): void {
    if (state.terminalEmitted) {
      return;
    }
    state.terminalEmitted = true;
    if (stopOwnedExpression && state.expressionId) {
      this.stopExpression();
    }
    state.onTerminal?.({
      runId: state.runId,
      status,
      reason: reason || undefined,
    });
  }

  public beginExternalAudioSignalSource(
    sourceId: string,
    options?: ExternalAudioSignalSourceOptions,
  ): void {
    this._speechSignalRuntime.beginSource(sourceId, options);
  }

  public writeExternalAudioSignalSource(
    sourceId: string,
    values: ExternalAudioSignalValues,
  ): void {
    this._speechSignalRuntime.writeSource(sourceId, values);
  }

  public endExternalAudioSignalSource(sourceId: string): void {
    this._speechSignalRuntime.endSource(sourceId);
  }

  public hasConfiguredLipSyncParameters(): boolean {
    if (!this._model || this._lipSyncIds.getSize() === 0) {
      return false;
    }
    for (let index = 0; index < this._lipSyncIds.getSize(); index += 1) {
      const parameterIndex = this._model.getParameterIndex(this._lipSyncIds.at(index));
      if (!this.isParameterIndexWritable(parameterIndex)) {
        return false;
      }
      const minValue = this._model.getParameterMinimumValue(parameterIndex);
      const defaultValue = this._model.getParameterDefaultValue(parameterIndex);
      const maxValue = this._model.getParameterMaximumValue(parameterIndex);
      if (
        !Number.isFinite(minValue)
        || !Number.isFinite(defaultValue)
        || !Number.isFinite(maxValue)
        || minValue > defaultValue
        || defaultValue >= maxValue
      ) {
        return false;
      }
    }
    return true;
  }

  private applyActiveParameterFrame(
    lipSyncIntensity: number,
    lipSyncActive: boolean,
  ): ActiveParameterFrameFailure | null {
    const execution = this._parameterMixer.resolveActiveFrame({
      model: this._model,
      directPlan: this._directParameterPlanState,
      lipSyncEnabled: this._lipsync === true,
      lipSyncActive,
      lipSyncIntensity,
      lipSyncParameterIds: this._lipSyncIds,
      getSpeechAudioGain: (axisId) => this._speechSignalRuntime.getSpeechAudioGain(axisId),
    });
    if (!execution.ok) {
      return {
        owner: execution.owner,
        reason: execution.reason,
      };
    }

    const planState = this._directParameterPlanState;
    const lipSyncDiagnosticSourceId = execution.directPlan.contributions.length === 0
      && execution.lipSyncContributionCount > 0
      ? this._speechSignalRuntime.getLipSyncDiagnosticSourceId()
      : null;
    if (execution.directPlan.shouldLogFrame && planState) {
      console.info("[LAppModel] Active parameter frame resolved.", {
        mode: planState.mode,
        emotion: planState.emotionLabel,
        parameters: execution.parameters.map((parameter) => ({
          parameterId: parameter.parameterIdRaw,
          baseValue: parameter.baseValue,
          unclampedValue: parameter.unclampedValue,
          value: parameter.value,
          clamped: parameter.clamped,
          contributions: parameter.contributions,
        })),
      });
      planState.diagnosticFrameCount += 1;
    } else if (lipSyncDiagnosticSourceId) {
      console.info("[LAppModel] Active parameter frame resolved.", {
        mode: "lip_sync",
        audioSourceId: lipSyncDiagnosticSourceId,
        parameters: execution.parameters.map((parameter) => ({
          parameterId: parameter.parameterIdRaw,
          baseValue: parameter.baseValue,
          unclampedValue: parameter.unclampedValue,
          value: parameter.value,
          clamped: parameter.clamped,
          contributions: parameter.contributions,
        })),
      });
      this._speechSignalRuntime.markLipSyncDiagnosticFrameLogged(lipSyncDiagnosticSourceId);
    }
    if (execution.directPlan.released && planState) {
      console.info("[LAppModel] Direct parameter plan released after parameter mixing.");
      this.stopDirectParameterPlan("", "completed");
    }
    return null;
  }

  private resolveSpeechPoseModulation(
    item: DirectSemanticParameterBinding,
  ): {
    amplitude: number;
    direction: number;
    delayMs: number;
    points: DirectSemanticParameterBinding["modulationPoints"];
  } {
    const modulation = this.parseSpeechPoseModulation(item);
    const amplitude = Math.min(
      item.maxSpeechOffset,
      Math.max(0, modulation.amplitude ?? 0),
    );
    return {
      amplitude,
      direction: modulation.direction ?? 1,
      delayMs: modulation.delayMs ?? 0,
      points: modulation.points,
    };
  }

  private parseSpeechPoseModulation(item: DirectSemanticParameterBinding): {
    amplitude: number | null;
    direction: number | null;
    delayMs: number | null;
    points: DirectSemanticParameterBinding["modulationPoints"];
  } {
    const modulation = item.modulation;
    if (!modulation || modulation.kind !== "speech_gesture_track") {
      return {
        amplitude: null,
        direction: null,
        delayMs: null,
        points: [],
      };
    }

    return {
      amplitude: modulation.amplitude,
      direction: modulation.direction === -1 ? -1 : 1,
      delayMs: modulation.delayMs,
      points: modulation.points,
    };
  }

  private isParameterIndexWritable(parameterIndex: number): boolean {
    if (!this._model) {
      return false;
    }
    return parameterIndex >= 0 && parameterIndex < this._model.getParameterCount();
  }

  private resolveWritableParameterIndex(parameterName: string): number | null {
    if (!this._model) {
      console.warn(`[LAppModel] resolveWritableParameterIndex('${parameterName}'): no model`);
      return null;
    }
    const normalizedName = String(parameterName || "").trim();
    if (!normalizedName) {
      console.warn(`[LAppModel] resolveWritableParameterIndex('${parameterName}'): empty name`);
      return null;
    }
    const idManager = CubismFramework.getIdManager();
    if (idManager) {
      const parameterId = idManager.getId(normalizedName);
      if (parameterId) {
        const parameterIndex = this._model.getParameterIndex(parameterId);
        if (this.isParameterIndexWritable(parameterIndex)) {
          if (LAppDefine.DebugLogEnable) {
            console.info(`[LAppModel] resolveWritableParameterIndex: resolved '${normalizedName}' via idManager -> index=${parameterIndex}`);
          }
          return parameterIndex;
        }
        console.error(`[LAppModel] resolveWritableParameterIndex('${parameterName}'): parameter is not writable (index=${parameterIndex}, model paramCount=${this._model.getParameterCount()}).`);
      }
    } else {
      console.error(`[LAppModel] resolveWritableParameterIndex('${parameterName}'): Cubism id manager is unavailable.`);
    }
    console.error(`[LAppModel] resolveWritableParameterIndex('${parameterName}'): exact parameter binding was not found.`);
    return null;
  }

  /**
   * コンストラクタ
   */
  public constructor() {
    super();

    this._modelSetting = null;
    this._modelHomeDir = null;
    this._userTimeSeconds = 0.0;

    this._eyeBlinkIds = new csmVector<CubismIdHandle>();
    this._lipSyncIds = new csmVector<CubismIdHandle>();

    this._motions = new csmMap<string, ACubismMotion>();
    this._expressions = new csmMap<string, ACubismMotion>();

    this._hitArea = new csmVector<csmRect>();
    this._userArea = new csmVector<csmRect>();

    const idManager = CubismFramework.getIdManager();
    
    if (idManager) {
      this._idParamAngleX = idManager.getId(
        CubismDefaultParameterId.ParamAngleX
      );
      this._idParamAngleY = idManager.getId(
        CubismDefaultParameterId.ParamAngleY
      );
      this._idParamAngleZ = idManager.getId(
        CubismDefaultParameterId.ParamAngleZ
      );
      this._idParamEyeBallX = idManager.getId(
        CubismDefaultParameterId.ParamEyeBallX
      );
      this._idParamEyeBallY = idManager.getId(
        CubismDefaultParameterId.ParamEyeBallY
      );
      this._idParamBodyAngleX = idManager.getId(
        CubismDefaultParameterId.ParamBodyAngleX
      );
    } else {
      // Initialize handles with null to avoid undefined errors
      this._idParamAngleX = null;
      this._idParamAngleY = null;
      this._idParamAngleZ = null;
      this._idParamEyeBallX = null;
      this._idParamEyeBallY = null;
      this._idParamBodyAngleX = null;
    }

    if (LAppDefine.MOCConsistencyValidationEnable) {
      this._mocConsistency = true;
    }

    this._state = LoadStep.LoadAssets;
    this._expressionCount = 0;
    this._textureCount = 0;
    this._motionCount = 0;
    this._allMotionCount = 0;
    this._consistency = false;
    this._directParameterPlanState = null;
    this._directParameterPlanError = "";
    this._motionStartError = "";
    this._parameterMixer = new ActiveParameterMixer();
    this._speechSignalRuntime = new SpeechSignalRuntime();
  }

  _modelSetting: ICubismModelSetting; // モデルセッティング情報
  _modelHomeDir: string; // モデルセッティングが置かれたディレクトリ
  _userTimeSeconds: number; // デルタ時間の積算値[秒]

  _eyeBlinkIds: csmVector<CubismIdHandle>; // モデルに設定された瞬き機能用パラメータID
  _lipSyncIds: csmVector<CubismIdHandle>; // モデルに設定されたリップシンク機能用パラメータID

  _motions: csmMap<string, ACubismMotion>; // 読み込まれているモーションのリスト
  _expressions: csmMap<string, ACubismMotion>; // 読み込まれている表情のリスト
  private _expressionStartError = '';

  _hitArea: csmVector<csmRect>;
  _userArea: csmVector<csmRect>;

  _idParamAngleX: CubismIdHandle; // パラメータID: ParamAngleX
  _idParamAngleY: CubismIdHandle; // パラメータID: ParamAngleY
  _idParamAngleZ: CubismIdHandle; // パラメータID: ParamAngleZ
  _idParamEyeBallX: CubismIdHandle; // パラメータID: ParamEyeBallX
  _idParamEyeBallY: CubismIdHandle; // パラメータID: ParamEyeBAllY
  _idParamBodyAngleX: CubismIdHandle; // パラメータID: ParamBodyAngleX

  _state: LoadStep; // 現在のステータス管理用
  _expressionCount: number; // 表情データカウント
  _textureCount: number; // テクスチャカウント
  _motionCount: number; // モーションデータカウント
  _allMotionCount: number; // モーション総数
  _consistency: boolean; // MOC3一貫性チェック管理用
  _directParameterPlanState: DirectParameterPlanState | null;
  _directParameterPlanError: string;
  _motionStartError: string;
  private _parameterMixer: ActiveParameterMixer;
  private _speechSignalRuntime: SpeechSignalRuntime;
}
