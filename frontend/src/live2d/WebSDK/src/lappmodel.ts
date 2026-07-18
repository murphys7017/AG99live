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
import type { SemanticParameterPlan } from "../../../types/protocol";

import * as LAppDefine from "./lappdefine";
import { frameBuffer, LAppDelegate } from "./lappdelegate";
import { canvas, gl } from "./lappglmanager";
import { LAppPal } from "./lapppal";
import { advanceParameterDynamics } from "./parameterdynamics";
import { prepareDirectParameterExecution } from "./directparameterplan";
import { TextureInfo } from "./lapptexturemanager";
import { CubismMoc } from "@framework/model/cubismmoc";
import {
  cancelLive2DModelLoad,
  getLive2DModelLoadState,
  isLive2DModelLoadActive,
  markLive2DModelFailed,
  markLive2DModelReady,
} from "./modelreadiness";

const AsyncMotionAcceptedHandle = { status: "async_motion_accepted" };

interface CatalogMotionLifecycleCallbacks {
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

const DIRECT_PARAMETER_AXIS_MAP: Record<string, string[]> = {
  head_yaw: ["ParamAngleX", "PARAM_ANGLE_X"],
  head_roll: ["ParamAngleZ", "PARAM_ANGLE_Z"],
  head_pitch: ["ParamAngleY", "PARAM_ANGLE_Y"],
  body_yaw: ["ParamBodyAngleX", "PARAM_BODY_ANGLE_X"],
  body_roll: ["ParamBodyAngleZ", "PARAM_BODY_ANGLE_Z", "BodyAngleY", "BODY_ANGLE_Y"],
  gaze_x: ["ParamEyeBallX", "PARAM_EYE_BALL_X"],
  gaze_y: ["ParamEyeBallY", "PARAM_EYE_BALL_Y"],
  eye_open_left: ["ParamEyeLOpen", "PARAM_EYE_L_OPEN"],
  eye_open_right: ["ParamEyeROpen", "PARAM_EYE_R_OPEN"],
  mouth_open: ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y", "ParamMouthOpen", "PARAM_MOUTH_OPEN"],
  mouth_smile: ["ParamMouthForm", "PARAM_MOUTH_FORM", "ParamMouthSmile", "PARAM_MOUTH_SMILE"],
  brow_bias: [
    "ParamBrowForm",
    "PARAM_BROW_FORM",
    "ParamBrowLOutterUp",
    "ParamBrowLDown",
    "ParamBrowRDown",
  ],
};

const DIRECT_PARAMETER_AXIS_NAMES = Object.keys(DIRECT_PARAMETER_AXIS_MAP);
const DIRECT_EXPRESSIVE_AXIS_GAIN = 1.35;
const DIRECT_EXPRESSIVE_AXIS_MIN_MAGNITUDE = 0.22;
const DIRECT_MAX_MISSING_AXIS_BINDINGS = 3;
const DIRECT_MAX_SUPPLEMENTARY_BINDING_FAILURES = 3;
const DIRECT_LIFE_MOTION_AXIS_CONFIG: Record<string, { amplitudeRatio: number; minAmplitude: number; maxAmplitude: number; frequencyHz: number }> = {
  head_yaw: { amplitudeRatio: 0.12, minAmplitude: 0.18, maxAmplitude: 1.2, frequencyHz: 0.62 },
  head_roll: { amplitudeRatio: 0.13, minAmplitude: 0.16, maxAmplitude: 1.1, frequencyHz: 0.55 },
  head_pitch: { amplitudeRatio: 0.10, minAmplitude: 0.14, maxAmplitude: 0.9, frequencyHz: 0.48 },
  body_yaw: { amplitudeRatio: 0.10, minAmplitude: 0.12, maxAmplitude: 0.9, frequencyHz: 0.45 },
  body_roll: { amplitudeRatio: 0.11, minAmplitude: 0.12, maxAmplitude: 0.9, frequencyHz: 0.42 },
  body_pitch: { amplitudeRatio: 0.09, minAmplitude: 0.10, maxAmplitude: 0.75, frequencyHz: 0.38 },
  gaze_x: { amplitudeRatio: 0.08, minAmplitude: 0.08, maxAmplitude: 0.45, frequencyHz: 0.75 },
  gaze_y: { amplitudeRatio: 0.08, minAmplitude: 0.08, maxAmplitude: 0.45, frequencyHz: 0.68 },
};
const SPEECH_HEAD_ENVELOPE_ATTACK_PER_SECOND = 8.0;
const SPEECH_HEAD_ENVELOPE_RELEASE_PER_SECOND = 3.0;
const SPEECH_BODY_ENVELOPE_ATTACK_PER_SECOND = 2.5;
const SPEECH_BODY_ENVELOPE_RELEASE_PER_SECOND = 1.2;
const SPEECH_AUDIO_GAIN_FLOOR = 0.16;
const SPEECH_AUDIO_GAIN_SPAN = 1.24;
const SPEECH_AUDIO_GAIN_MAX = 1.4;
const SPEECH_AUDIO_PITCH_GAIN_MAX = 1.0;
const SPEECH_BODY_GAIN_FLOOR = 0.08;
const SPEECH_BODY_GAIN_SPAN = 0.72;
const SPEECH_BODY_GAIN_MAX = 0.8;
interface DirectParameterAxisBinding {
  axisName: string;
  axisValue: number;
  parameterName: string;
  parameterId: CubismIdHandle;
  parameterIndex: number;
  calibration: DirectParameterAxisCalibration | null;
  directTargetValue: number | null;
  weight: number;
}

interface DirectSupplementaryBinding {
  parameterIdRaw: string;
  targetValue: number;
  weight: number;
  sourceAtomId: string;
  channel: string;
  parameterId: CubismIdHandle;
  parameterIndex: number;
}

interface DirectSemanticParameterBinding {
  axisId: string;
  parameterIdRaw: string;
  targetValue: number;
  neutralTargetValue: number;
  weight: number;
  inputValue: number | null;
  source: string;
  keyframes: Array<{
    atMs: number;
    transitionMs: number;
    targetValue: number;
  }>;
  modulationAmplitude: number;
  modulationDirection: number;
  modulationDelayMs: number;
  modulationPoints: Array<{
    atMs: number;
    transitionMs: number;
    value: number;
  }>;
  lifeMotionPhase: number;
  lifeMotionAmplitude: number;
  lifeMotionFrequencyHz: number;
  modulation: {
    kind: string;
    preset: string;
    amplitude: number | null;
    direction: number | null;
    delayMs: number | null;
    points: Array<{
      atMs: number;
      transitionMs: number;
      value: number;
    }>;
  } | null;
  maxVelocity: number;
  maxAcceleration: number;
  lifeMotionScale: number;
  maxSpeechOffset: number;
  parameterId: CubismIdHandle;
  parameterIndex: number;
  dynamicallyLimitedValue: number | null;
  dynamicVelocity: number;
  lastDynamicElapsedMs: number | null;
}

interface DirectParameterCalibrationRange {
  min: number | null;
  max: number | null;
}

interface DirectParameterAxisCalibration {
  parameterId: string;
  parameterIds: string[];
  direction: number | null;
  baseline: number | null;
  recommendedRange: DirectParameterCalibrationRange | null;
  observedRange: DirectParameterCalibrationRange | null;
  confidence: string;
  source: string;
  recommended: boolean | null;
  safeToApply: boolean | null;
  skipReason: string;
}

interface DirectParameterCalibrationProfile {
  schemaVersion: string;
  axes: Record<string, DirectParameterAxisCalibration>;
}

interface DirectParameterPlanState {
  mode: "expressive" | "idle";
  emotionLabel: string;
  timing: {
    durationMs: number;
    blendInMs: number;
    holdMs: number;
    blendOutMs: number;
    curvePreset: "smooth_hold" | "snap_hold_soft_release" | "slow_build_quick_release" | "pulse_settle" | "breathing_swell";
    totalMs: number;
  };
  axisBindings: DirectParameterAxisBinding[];
  supplementaryBindings: DirectSupplementaryBinding[];
  semanticBindings: DirectSemanticParameterBinding[];
  usesCalibration: boolean;
  usesBindingProfile: boolean;
  startedAtMs: number;
  diagnosticFrameCount: number;
  /** 本次参数计划的唯一标识符。由 startDirectParameterPlan 生成并回传。 */
  runId: string;
  /** 参数计划完成时的回调。 */
  onTerminal?: (event: {
    runId: string;
    status: "completed" | "stopped" | "failed" | "rejected";
    reason?: string;
  }) => void;
  /** 防止重复发射完成事件 */
  terminalEmitted: boolean;
}

/**
 * ユーザーが実際に使用するモデルの実装クラス<br>
 * モデル生成、機能コンポーネント生成、更新処理とレンダリングの呼び出しを行う。
 */
export class LAppModel extends CubismUserModel {
  private readonly _loadGeneration = getLive2DModelLoadState().generation;
  private _released = false;
  private _catalogMotionRequestGeneration = 0;
  private _activeCatalogMotionStop: ((reason: string) => void) | null = null;

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
    this.stopMotion("motion_model_released");
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

      // Some valid models expose a writable mouth parameter but omit the
      // optional LipSync group from model3.json. Discover that capability
      // explicitly so audio lip sync does not silently become energy-only.
      if (this._lipSyncIds.getSize() === 0 && this._model != null) {
        const idManager = CubismFramework.getIdManager();
        const mouthParameterNames = [
          "ParamMouthOpenY",
          "PARAM_MOUTH_OPEN_Y",
          "ParamMouthOpen",
          "PARAM_MOUTH_OPEN",
        ];
        for (const parameterName of mouthParameterNames) {
          const parameterId = idManager?.getId(parameterName);
          if (!parameterId) {
            continue;
          }
          const parameterIndex = this._model.getParameterIndex(parameterId);
          if (
            parameterIndex >= 0
            && parameterIndex < this._model.getParameterCount()
          ) {
            this._lipSyncIds.pushBack(parameterId);
            console.info(
              `[LAppModel] lip sync parameter auto-detected: ${parameterName}`,
            );
            break;
          }
        }
      }

      if (this._lipSyncIds.getSize() === 0) {
        console.error(
          "[LAppModel] no writable lip sync parameter is configured or discoverable.",
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
    let lipSyncValue = 0.0;
    let speechEnergyValue = 0.0;
    if (this._lipsync) {
      const liveLipSyncValue = this.resolveExternalLipSyncValue();
      lipSyncValue = liveLipSyncValue ?? 0;
    }
    speechEnergyValue = this.resolveExternalSpeechEnergyValue() ?? 0;
    this.updateSpeechAudioEnvelope(speechEnergyValue, deltaTimeSeconds);

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
      motionUpdated = this._motionManager.updateMotion(
        this._model,
        deltaTimeSeconds
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

    // Direct parameter overlay should run before physics so physics-driven
    // output parameters can consume these values in the same frame.
    let directPlanFailure: string | null = null;
    try {
      directPlanFailure = this.applyDirectParameterPlanOverlay();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      directPlanFailure = `v2_parameter_frame_exception:${message || "unknown_error"}`;
      console.error("[LAppModel] Direct parameter frame execution failed.", error);
    }
    if (directPlanFailure) {
      this.stopDirectParameterPlan(directPlanFailure, "failed");
    }

    // 物理演算の設定
    if (this._physics != null) {
      this._physics.evaluate(this._model, deltaTimeSeconds);
    }

    // Lip sync settings
    if (this._lipsync) {
      const lipSyncWeight = 4.0;

      for (let i = 0; i < this._lipSyncIds.getSize(); ++i) {
        this._model.addParameterValueById(
          this._lipSyncIds.at(i),
          lipSyncValue,
          lipSyncWeight
        );
      }
    }

    // ポーズの設定
    if (this._pose != null) {
      this._pose.updateParameters(this._model, deltaTimeSeconds);
    }

    this._model.update();
  }

  public setAmbientMotionEnabled(enabled: boolean): void {
    LAppDefine.setAmbientMotionEnabled(enabled);
    if (!enabled) {
      this.stopMotion();
    }
  }

  public stopMotion(reason = "motion_stopped"): void {
    const activeStop = this._activeCatalogMotionStop;
    this._activeCatalogMotionStop = null;
    activeStop?.(reason);
    this._catalogMotionRequestGeneration += 1;
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
    const requestGeneration = ++this._catalogMotionRequestGeneration;
    let terminalSettled = false;
    let activeStop: ((reason: string) => void) | null = null;
    const isCurrentRequest = () =>
      !this._released && this._catalogMotionRequestGeneration === requestGeneration;
    const clearActiveStop = () => {
      if (this._activeCatalogMotionStop === activeStop) {
        this._activeCatalogMotionStop = null;
      }
    };
    const finish = () => {
      if (terminalSettled) {
        return;
      }
      terminalSettled = true;
      clearActiveStop();
      lifecycleCallbacks?.onFinished?.();
    };
    const fail = (reason: string) => {
      if (terminalSettled) {
        return;
      }
      terminalSettled = true;
      clearActiveStop();
      lifecycleCallbacks?.onFailed?.(reason);
    };
    const start = () => {
      if (terminalSettled) {
        return;
      }
      lifecycleCallbacks?.onStarted?.();
    };
    this._motionStartError = "";
    if (this._released || !this._motionManager) {
      this._motionStartError = "motion_model_released";
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
    this._activeCatalogMotionStop = null;
    previousActiveStop?.("motion_replaced");
    activeStop = (reason: string) => {
      if (terminalSettled) {
        return;
      }
      terminalSettled = true;
      clearActiveStop();
      lifecycleCallbacks?.onInterrupted?.(reason);
    };
    this._activeCatalogMotionStop = activeStop;

    const motionFileName = this._modelSetting.getMotionFileName(group, no);

    // ex) idle_0 or _0 if group is ""
    const name = `${group}_${no}`;
    let motion: CubismMotion = this._motions.getValue(name) as CubismMotion;
    let autoDelete = false;
    const finishAsyncMotionWithoutStart = (reason: string): void => {
      this._motionStartError = reason;
      if (this._motionManager && this._motionManager.getReservePriority() === priority) {
        this._motionManager.setReservePriority(0);
      }
      fail(reason);
    };

    if (motion == null) {
      if (LAppDefine.DebugLogEnable) {
        console.log(`[APP] startMotion: Motion '${name}' not found in cache, fetching: ${motionFileName}`);
      }
      this.fetchRuntimeArrayBuffer(`${this._modelHomeDir}${motionFileName}`)
        .then((arrayBuffer) => {
          if (!isCurrentRequest() || !this._motionManager) {
            fail("motion_model_released");
            return;
          }
          motion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            null, // Pass null for name here? Original code did. Let's keep it for now.
            finish
          );

          if (motion == null) {
             if (LAppDefine.DebugLogEnable) {
                console.error(`[APP] startMotion: Failed to load motion from fetched data for '${name}'`);
             }
            finishAsyncMotionWithoutStart("motion_load_failed");
            return;
          }

          let fadeTime: number = this._modelSetting.getMotionFadeInTimeValue(
            group,
            no
          );

          if (fadeTime >= 0.0) {
            motion.setFadeInTime(fadeTime);
          }

          fadeTime = this._modelSetting.getMotionFadeOutTimeValue(group, no);
          if (fadeTime >= 0.0) {
            motion.setFadeOutTime(fadeTime);
          }

          motion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);
          motion.setFinishedMotionHandler(finish);
          autoDelete = true; // 終了時にメモリから削除

          // Start the motion *after* it's loaded (moved from outside)
          if (LAppDefine.DebugLogEnable) {
            console.log(`[APP] startMotion: Starting fetched motion '${name}'`);
          }
          const loadedHandle = this._motionManager.startMotionPriority(
            motion,
            autoDelete,
            priority
          );
          if (loadedHandle === InvalidMotionQueueEntryHandleValue) {
            finishAsyncMotionWithoutStart("motion_start_rejected");
            return;
          }
          start();
        })
        .catch((error) => {
          if (!isCurrentRequest()) {
            fail("motion_model_released");
            return;
          }
          if (LAppDefine.DebugLogEnable) {
            console.error(`[APP] startMotion: Failed to fetch motion '${name}'`, error);
          }
          finishAsyncMotionWithoutStart("motion_fetch_failed");
        });
      return AsyncMotionAcceptedHandle;
    } else {
      if (LAppDefine.DebugLogEnable) {
        console.log(`[APP] startMotion: Motion '${name}' found in cache. Starting.`);
      }
      motion.setFinishedMotionHandler(finish);
      // Start the motion if found in cache
      const handle = this._motionManager.startMotionPriority(
          motion,
          autoDelete, // Should be false for cached motions? Let's assume true based on original code.
          priority
      );
      if (handle === InvalidMotionQueueEntryHandleValue) {
        this._motionStartError = "motion_start_rejected";
        fail(this._motionStartError);
      } else {
        start();
      }
      return handle;
    }

    // Original code had voice logic and startMotionPriority call here, moved inside blocks
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

  public stopExpression(): void {
    this._expressionManager.stopAllMotions();
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

  private hasModelParameter(parameterId: CubismIdHandle | null): boolean {
    if (!parameterId || !this._model) {
      return false;
    }

    const parameterIndex = this._model.getParameterIndex(parameterId);
    return parameterIndex >= 0 && parameterIndex < this._model.getParameterCount();
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

  public startDirectParameterPlan(plan: SemanticParameterPlan, options?: unknown): boolean {
    const execution = prepareDirectParameterExecution(plan);
    console.info("[LAppModel] starting validated plan. mode=", plan.mode, "emotion=", plan.emotion_label);

    if (!this._model || this._state != LoadStep.CompleteSetup) {
      console.warn("[LAppModel] model not ready. _state=", this._state);
      this.stopDirectParameterPlan("model_not_ready");
      return false;
    }

    // 从 options 中提取 runId 和 onTerminal 回调
    const opts = (options && typeof options === 'object') ? options : {};
    const runId = opts.runId || ('direct-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    const onTerminal = typeof opts.onTerminal === 'function' ? opts.onTerminal : undefined;

    return this.startSemanticParameterPlan(execution, runId, onTerminal);
  }

  public stopDirectParameterPlan(reason = "", status = "stopped"): void {
    const state = this._directParameterPlanState;
    this._directParameterPlanState = null;
    this._directParameterPlanError = reason ? String(reason) : "";
    if (this._directParameterPlanError) {
      console.error(`[APP] Direct parameter plan stopped: ${this._directParameterPlanError}`);
    }
    // 发射完成事件（仅一次）
    if (state && !state.terminalEmitted) {
      state.terminalEmitted = true;
      if (typeof state.onTerminal === "function") {
        state.onTerminal({
          runId: state.runId,
          status: status,
          reason: reason || undefined,
        });
      }
    }
  }

  public getDirectParameterPlanError(): string {
    return this._directParameterPlanError || "";
  }

  public hasActiveDirectParameterPlan(): boolean {
    return this._directParameterPlanState !== null;
  }

  private startSemanticParameterPlan(parsed: {
    plan: any;
    timing: DirectParameterPlanState["timing"];
    reason: string;
  }, runId?: string, onTerminal?: (event: any) => void): boolean {
    const semanticBindings: DirectSemanticParameterBinding[] = [];
    const seenParameterIndices = new Set<number>();
    const bindingWarnings = Array.isArray(parsed.plan.diagnostics?.warnings)
      ? [...parsed.plan.diagnostics.warnings]
      : [];

    for (const [index, item] of parsed.plan.parameters.entries()) {
      const parameterIdRaw = String(item.parameter_id || "").trim();
      const axisId = String(item.axis_id || "").trim();
      const resolved = this.resolveWritableParameter(parameterIdRaw);
      if (!resolved) {
        this.stopDirectParameterPlan(
          `v2_parameter_missing_runtime_parameter:${axisId}:${parameterIdRaw || index}`,
        );
        return false;
      }
      if (seenParameterIndices.has(resolved.parameterIndex)) {
        this.stopDirectParameterPlan(
          `v2_parameter_duplicate_runtime_parameter:${axisId}:${parameterIdRaw}`,
        );
        return false;
      }
      if (!this.isParameterIndexWritable(resolved.parameterIndex)) {
        this.stopDirectParameterPlan(
          `v2_parameter_not_writable:${axisId}:${parameterIdRaw}`,
        );
        return false;
      }
      const minValue = this._model.getParameterMinimumValue(resolved.parameterIndex);
      const maxValue = this._model.getParameterMaximumValue(resolved.parameterIndex);
      const targetValue = Number(item.target_value);
      if (targetValue < minValue || targetValue > maxValue) {
        this.stopDirectParameterPlan(`v2_parameter_target_out_of_runtime_range:${parameterIdRaw}`);
        return false;
      }
      const neutralTargetValue = Number(item.neutral_target_value);
      if (neutralTargetValue < minValue || neutralTargetValue > maxValue) {
        this.stopDirectParameterPlan(`v2_parameter_neutral_out_of_runtime_range:${parameterIdRaw}`);
        return false;
      }
      const keyframes = Array.isArray(item.keyframes)
        ? item.keyframes.map((keyframe: any) => ({
            atMs: Number(keyframe.at_ms),
            transitionMs: Number(keyframe.transition_ms),
            targetValue: Number(keyframe.target_value),
          }))
        : [];
      if (keyframes.some((keyframe) => keyframe.targetValue < minValue || keyframe.targetValue > maxValue)) {
        this.stopDirectParameterPlan(`v2_parameter_keyframe_out_of_runtime_range:${parameterIdRaw}`);
        return false;
      }
      seenParameterIndices.add(resolved.parameterIndex);
      semanticBindings.push({
        axisId,
        parameterIdRaw,
        targetValue,
        neutralTargetValue,
        weight: Number(item.weight),
        inputValue: Number.isFinite(Number(item.input_value)) ? Number(item.input_value) : null,
        source: String(item.source),
        keyframes,
        modulationAmplitude: 0,
        modulationDirection: 1,
        modulationDelayMs: 0,
        modulationPoints: [],
        lifeMotionPhase: this.resolveLifeMotionPhase(axisId, parameterIdRaw),
        lifeMotionAmplitude: 0,
        lifeMotionFrequencyHz: 0,
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
              ? item.modulation.points.map((point: any) => ({
                atMs: Number(point.at_ms),
                transitionMs: Number(point.transition_ms),
                value: Number(point.value),
              }))
              : [],
          }
          : null,
        maxVelocity: Number(item.dynamics.max_velocity),
        maxAcceleration: Number(item.dynamics.max_acceleration),
        lifeMotionScale: Number(item.dynamics.life_motion_scale),
        maxSpeechOffset: Number(item.dynamics.max_speech_offset),
        parameterId: resolved.parameterId,
        parameterIndex: resolved.parameterIndex,
        dynamicallyLimitedValue: null,
        dynamicVelocity: 0,
        lastDynamicElapsedMs: null,
      });
    }

    if (semanticBindings.length === 0) {
      this.stopDirectParameterPlan("v2_parameters_empty_after_runtime_filter");
      return false;
    }
    if (bindingWarnings.length > 0) {
      if (!parsed.plan.diagnostics || typeof parsed.plan.diagnostics !== "object") {
        parsed.plan.diagnostics = {};
      }
      parsed.plan.diagnostics.warnings = bindingWarnings;
    }

    for (const item of semanticBindings) {
      if (!item.source.startsWith("speech_pose")) {
        const lifeMotion = this.resolveSemanticLifeMotion(item);
        item.lifeMotionAmplitude = lifeMotion.amplitude;
        item.lifeMotionFrequencyHz = lifeMotion.frequencyHz;
      }
      if (item.modulation) {
        const modulation = this.resolveSpeechPoseModulation(item);
        item.modulationAmplitude = modulation.amplitude;
        item.modulationDirection = modulation.direction;
        item.modulationDelayMs = modulation.delayMs;
        item.modulationPoints = modulation.points;
      }
    }

    console.info("[LAppModel] Semantic parameter bindings ready. Activating v2 plan.", {
      parameterCount: semanticBindings.length,
      profileId: parsed.plan.profile_id,
      profileRevision: parsed.plan.profile_revision,
    });
    this._directParameterPlanState = {
      mode: parsed.plan.mode,
      emotionLabel: parsed.plan.emotion_label,
      timing: parsed.timing,
      axisBindings: [],
      supplementaryBindings: [],
      semanticBindings,
      usesCalibration: false,
      usesBindingProfile: true,
      startedAtMs: performance.now(),
      diagnosticFrameCount: 0,
      runId: runId || ('direct-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
      onTerminal: onTerminal,
      terminalEmitted: false,
    };
    this._directParameterPlanError = "";
    return true;
  }

  public setExternalLipSyncValue(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    this._externalLipSyncValue = Math.max(0, Math.min(1, value));
    this._externalLipSyncUpdatedAtMs = performance.now();
  }

  public clearExternalLipSyncValue(): void {
    this._externalLipSyncValue = null;
    this._externalLipSyncUpdatedAtMs = 0;
  }

  public setExternalSpeechEnergyValue(value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    this._externalSpeechEnergyValue = Math.max(0, Math.min(1, value));
    this._externalSpeechEnergyUpdatedAtMs = performance.now();
  }

  public clearExternalSpeechEnergyValue(): void {
    this._externalSpeechEnergyValue = null;
    this._externalSpeechEnergyUpdatedAtMs = 0;
  }

  public hasConfiguredLipSyncParameters(): boolean {
    return this._lipSyncIds.getSize() > 0;
  }

  private applyDirectParameterPlanOverlay(): string | null {
    if (!this._directParameterPlanState || !this._model) {
      return null;
    }

    const planState = this._directParameterPlanState;
    const elapsedMs = Math.max(0, performance.now() - planState.startedAtMs);
    const easing = this.resolvePlanEasing(elapsedMs, planState.timing);
    const shouldLogFrame = planState.diagnosticFrameCount < 2;
    if (shouldLogFrame) {
      console.info(`[LAppModel] applyDirectParameterPlanOverlay: mode=${planState.mode}, emotion=${planState.emotionLabel}, totalMs=${planState.timing.totalMs}, blendIn=${planState.timing.blendInMs}, hold=${planState.timing.holdMs}, blendOut=${planState.timing.blendOutMs}, axisCount=${planState.axisBindings.length}, semanticCount=${planState.semanticBindings.length}, suppCount=${planState.supplementaryBindings.length}, calibrated=${planState.usesCalibration}, bindingProfile=${planState.usesBindingProfile}`);
    }

    for (const item of planState.semanticBindings) {
      if (!this.isParameterIndexWritable(item.parameterIndex)) {
        console.warn(`[LAppModel] applyDirectParameterPlanOverlay: v2 parameter not writable axis=${item.axisId} param=${item.parameterIdRaw} idx=${item.parameterIndex}`);
        return `v2_parameter_not_writable:${item.parameterIdRaw}`;
      }

      const minValue = this._model.getParameterMinimumValue(item.parameterIndex);
      const maxValue = this._model.getParameterMaximumValue(item.parameterIndex);
      if (item.targetValue < minValue || item.targetValue > maxValue) {
        return `v2_parameter_target_out_of_runtime_range:${item.parameterIdRaw}`;
      }

      const baseValue = this._model.getParameterValueByIndex(item.parameterIndex);
      const rawFrameTargetValue = this.resolveSemanticBindingFrameTarget(
        item,
        elapsedMs,
        item.targetValue,
        minValue,
        maxValue,
      );
      const easedFrameTargetValue = baseValue
        + (rawFrameTargetValue - baseValue) * easing;
      const frameTargetValue = this.resolveDynamicallyLimitedTarget(
        item,
        easedFrameTargetValue,
        baseValue,
        elapsedMs,
        minValue,
        maxValue,
      );
      this._model.setParameterValueById(item.parameterId, frameTargetValue);
      const readbackValue = this._model.getParameterValueByIndex(item.parameterIndex);
      if (Math.abs(readbackValue - frameTargetValue) > 0.001) {
        console.warn(
          `[LAppModel] v2 setParam readback mismatch axis=${item.axisId} param=${item.parameterIdRaw} wrote=${frameTargetValue} readback=${readbackValue}`,
        );
        return `v2_parameter_write_mismatch:${item.parameterIdRaw}`;
      }
      if (shouldLogFrame) {
        console.info(`[LAppModel] v2 setParam axis=${item.axisId} param=${item.parameterIdRaw} input=${item.inputValue} base=${baseValue} rawTarget=${rawFrameTargetValue} easedTarget=${easedFrameTargetValue} limitedTarget=${frameTargetValue} weight=${item.weight} readback=${readbackValue} easing=${easing}`);
      }
    }

    if (shouldLogFrame) {
      planState.diagnosticFrameCount += 1;
    }

    if (elapsedMs >= planState.timing.totalMs) {
      console.info(`[LAppModel] applyDirectParameterPlanOverlay: plan complete at ${elapsedMs}ms >= ${planState.timing.totalMs}ms, stopping.`);
      this.stopDirectParameterPlan("", "completed");
    }
    return null;
  }

  private mapAxisValueForExecution(
    axisValue: number,
    mode: "expressive" | "idle",
    calibration: DirectParameterAxisCalibration | null,
    minValue: number,
    maxValue: number,
  ): number {
    const executableCalibration = this.resolveExecutableAxisCalibration(calibration);
    const effectiveAxisValue = executableCalibration?.direction !== null && executableCalibration?.direction !== undefined && executableCalibration.direction < 0
      ? 100.0 - axisValue
      : axisValue;
    const mappedAxisValue = this.applyExpressiveAxisGain(effectiveAxisValue, mode);

    if (!this.hasDirectParameterExecutionRange(executableCalibration)) {
      return minValue + (maxValue - minValue) * (mappedAxisValue / 100.0);
    }

    const baseline = this.resolveCalibratedBaseline(executableCalibration, minValue, maxValue);
    const recommendedRange = this.resolveCalibratedRange(executableCalibration.recommendedRange, baseline, minValue, maxValue);
    const observedRange = this.resolveCalibratedRange(executableCalibration.observedRange, baseline, minValue, maxValue);

    if (Math.abs(mappedAxisValue - 50.0) <= 0.0001) {
      return baseline;
    }

    if (mappedAxisValue < 50.0) {
      const ratio = (50.0 - mappedAxisValue) / 50.0;
      return this.interpolateCalibratedAxisSide(
        ratio,
        baseline,
        recommendedRange?.min ?? null,
        observedRange?.min ?? null,
      );
    }

    const ratio = (mappedAxisValue - 50.0) / 50.0;
    return this.interpolateCalibratedAxisSide(
      ratio,
      baseline,
      recommendedRange?.max ?? null,
      observedRange?.max ?? null,
    );
  }

  private applyExpressiveAxisGain(
    axisValue: number,
    mode: "expressive" | "idle",
  ): number {
    const clamped = Math.max(0, Math.min(100, Number(axisValue)));
    if (mode !== "expressive") {
      return clamped;
    }

    const centered = (clamped - 50.0) / 50.0;
    const magnitude = Math.abs(centered);
    if (magnitude <= 0.0001) {
      return 50.0;
    }

    const boostedMagnitude = Math.min(
      1.0,
      Math.max(
        magnitude * DIRECT_EXPRESSIVE_AXIS_GAIN,
        DIRECT_EXPRESSIVE_AXIS_MIN_MAGNITUDE,
      ),
    );
    const signed = centered < 0 ? -1.0 : 1.0;
    return 50.0 + signed * boostedMagnitude * 50.0;
  }

  private axisCalibrationInfluencesExecution(
    calibration: DirectParameterAxisCalibration | null,
  ): boolean {
    const executableCalibration = this.resolveExecutableAxisCalibration(calibration);
    if (!executableCalibration) {
      return false;
    }
    return executableCalibration.direction !== null || this.hasDirectParameterExecutionRange(executableCalibration);
  }

  private resolveExecutableAxisCalibration(
    calibration: DirectParameterAxisCalibration | null,
  ): DirectParameterAxisCalibration | null {
    if (!calibration) {
      return null;
    }
    if (calibration.safeToApply !== true) {
      return null;
    }
    if (calibration.recommended === false) {
      return null;
    }
    return calibration;
  }

  private hasDirectParameterExecutionRange(
    calibration: DirectParameterAxisCalibration | null,
  ): calibration is DirectParameterAxisCalibration {
    if (!calibration) {
      return false;
    }
    return Boolean(calibration.recommendedRange || calibration.observedRange);
  }

  private resolveCalibratedBaseline(
    calibration: DirectParameterAxisCalibration,
    minValue: number,
    maxValue: number,
  ): number {
    const baselineCandidates = [
      calibration.baseline,
      this.resolveRangeMidpoint(calibration.recommendedRange),
      this.resolveRangeMidpoint(calibration.observedRange),
      (minValue + maxValue) * 0.5,
    ];

    for (const candidate of baselineCandidates) {
      if (Number.isFinite(candidate)) {
        return this.clampNumber(candidate, minValue, maxValue);
      }
    }

    return this.clampNumber((minValue + maxValue) * 0.5, minValue, maxValue);
  }

  private resolveRangeMidpoint(
    range: DirectParameterCalibrationRange | null,
  ): number | null {
    if (!range) {
      return null;
    }
    if (Number.isFinite(range.min) && Number.isFinite(range.max)) {
      return (Number(range.min) + Number(range.max)) * 0.5;
    }
    if (Number.isFinite(range.min)) {
      return Number(range.min);
    }
    if (Number.isFinite(range.max)) {
      return Number(range.max);
    }
    return null;
  }

  private resolveCalibratedRange(
    range: DirectParameterCalibrationRange | null,
    baseline: number,
    minValue: number,
    maxValue: number,
  ): DirectParameterCalibrationRange | null {
    if (!range) {
      return null;
    }

    const nextMin = Number.isFinite(range.min)
      ? this.clampNumber(Number(range.min), minValue, maxValue)
      : baseline;
    const nextMax = Number.isFinite(range.max)
      ? this.clampNumber(Number(range.max), minValue, maxValue)
      : baseline;

    return nextMin <= nextMax
      ? { min: nextMin, max: nextMax }
      : { min: nextMax, max: nextMin };
  }

  private interpolateCalibratedAxisSide(
    ratio: number,
    baseline: number,
    recommendedTarget: number | null,
    observedTarget: number | null,
  ): number {
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const hasRecommended = Number.isFinite(recommendedTarget);
    const hasObserved = Number.isFinite(observedTarget);

    if (hasRecommended && hasObserved && Math.abs(Number(observedTarget) - Number(recommendedTarget)) > 0.0001) {
      if (clampedRatio <= 0.5) {
        return baseline + (Number(recommendedTarget) - baseline) * (clampedRatio * 2.0);
      }
      return Number(recommendedTarget) + (Number(observedTarget) - Number(recommendedTarget)) * ((clampedRatio - 0.5) * 2.0);
    }

    const fallbackTarget = hasRecommended
      ? Number(recommendedTarget)
      : hasObserved
        ? Number(observedTarget)
        : baseline;

    return baseline + (fallbackTarget - baseline) * clampedRatio;
  }

  private clampNumber(value: number, minValue: number, maxValue: number): number {
    return Math.min(maxValue, Math.max(minValue, Number(value)));
  }

  private resolvePlanEasing(
    elapsedMs: number,
    timing: DirectParameterPlanState["timing"],
  ): number {
    const elapsed = Math.max(0, elapsedMs);
    const blendInMs = Math.max(0, timing.blendInMs);
    const holdMs = Math.max(0, timing.holdMs);
    const blendOutMs = Math.max(0, timing.blendOutMs);

    if (blendInMs > 0 && elapsed < blendInMs) {
      const progress = elapsed / blendInMs;
      if (timing.curvePreset === "slow_build_quick_release") {
        return progress * progress;
      }
      if (timing.curvePreset === "pulse_settle") {
        return Math.min(1.08, this.easeOutBack(progress));
      }
      return this.smoothstep(progress);
    }
    if (elapsed < blendInMs + holdMs) {
      if (timing.curvePreset === "breathing_swell") {
        const progress = holdMs > 0 ? (elapsed - blendInMs) / holdMs : 1;
        // Keep both hold boundaries continuous with the blend-in/out value.
        return 1 - 0.06 * Math.sin(Math.PI * progress);
      }
      if (timing.curvePreset === "pulse_settle") {
        const progress = holdMs > 0 ? (elapsed - blendInMs) / holdMs : 1;
        return 1 - 0.06 * Math.sin(Math.PI * progress);
      }
      return 1.0;
    }
    if (blendOutMs > 0 && elapsed < blendInMs + holdMs + blendOutMs) {
      const outProgress = (elapsed - blendInMs - holdMs) / blendOutMs;
      return this.smoothstep(Math.max(0, 1 - outProgress));
    }
    return 0.0;
  }

  private smoothstep(value: number): number {
    const x = Math.max(0, Math.min(1, value));
    return x * x * (3 - 2 * x);
  }

  private updateSpeechAudioEnvelope(
    lipSyncValue: number,
    deltaTimeSeconds: number,
  ): void {
    const target = this.smoothstep(Math.max(0, Math.min(1, lipSyncValue)));
    this._speechAudioEnvelope = this.updateEnvelopeValue(
      this._speechAudioEnvelope,
      target,
      deltaTimeSeconds,
      SPEECH_HEAD_ENVELOPE_ATTACK_PER_SECOND,
      SPEECH_HEAD_ENVELOPE_RELEASE_PER_SECOND,
    );
    this._speechBodyEnvelope = this.updateEnvelopeValue(
      this._speechBodyEnvelope,
      target,
      deltaTimeSeconds,
      SPEECH_BODY_ENVELOPE_ATTACK_PER_SECOND,
      SPEECH_BODY_ENVELOPE_RELEASE_PER_SECOND,
    );
    if (this._speechAudioEnvelope < 0.001) {
      this._speechAudioEnvelope = 0;
    }
    if (this._speechBodyEnvelope < 0.001) {
      this._speechBodyEnvelope = 0;
    }
  }

  private updateEnvelopeValue(
    current: number,
    target: number,
    deltaTimeSeconds: number,
    attackPerSecond: number,
    releasePerSecond: number,
  ): number {
    const rate = target > current ? attackPerSecond : releasePerSecond;
    const blend = 1 - Math.exp(-Math.max(0, deltaTimeSeconds) * rate);
    return current + (target - current) * blend;
  }

  private resolveSpeechAudioGain(item: DirectSemanticParameterBinding): number {
    const channelName = item.axisId.startsWith("voice_following.")
      ? item.axisId.slice("voice_following.".length).split("|")[0]
      : item.axisId;
    const rawGain = channelName.startsWith("body_")
      ? Math.min(
          SPEECH_BODY_GAIN_MAX,
          SPEECH_BODY_GAIN_FLOOR + this._speechBodyEnvelope * SPEECH_BODY_GAIN_SPAN,
        )
      : Math.min(
          SPEECH_AUDIO_GAIN_MAX,
          SPEECH_AUDIO_GAIN_FLOOR + this._speechAudioEnvelope * SPEECH_AUDIO_GAIN_SPAN,
        );
    return channelName.includes("pitch")
      ? Math.min(SPEECH_AUDIO_PITCH_GAIN_MAX, rawGain)
      : rawGain;
  }

  private resolveSemanticBindingFrameTarget(
    item: DirectSemanticParameterBinding,
    elapsedMs: number,
    fallbackTargetValue: number,
    minValue: number,
    maxValue: number,
  ): number {
    const sequenceTargetValue = this.resolveSemanticSequenceTarget(
      item,
      elapsedMs,
      fallbackTargetValue,
    );
    let resolvedTargetValue = sequenceTargetValue;
    if (!item.source.startsWith("speech_pose")) {
      if (item.lifeMotionAmplitude <= 0 || item.lifeMotionFrequencyHz <= 0) {
        resolvedTargetValue = sequenceTargetValue;
      } else {
        const cycleRadians = ((elapsedMs / 1000) * item.lifeMotionFrequencyHz * Math.PI * 2) + item.lifeMotionPhase;
        const secondaryCycleRadians = ((elapsedMs / 1000) * item.lifeMotionFrequencyHz * 0.47 * Math.PI * 2) + item.lifeMotionPhase * 0.37;
        resolvedTargetValue =
          sequenceTargetValue
          + Math.sin(cycleRadians) * item.lifeMotionAmplitude
          + Math.sin(secondaryCycleRadians) * item.lifeMotionAmplitude * 0.35;
      }
    }

    if (item.modulationAmplitude <= 0) {
      return Math.max(minValue, Math.min(maxValue, resolvedTargetValue));
    }

    const gestureValue = this.resolveSpeechGestureTrackValue(item, elapsedMs);
    const audioGain = this.resolveSpeechAudioGain(item);
    const modulatedValue =
      resolvedTargetValue
      + gestureValue
        * item.modulationAmplitude
        * item.modulationDirection
        * audioGain;
    return Math.max(minValue, Math.min(maxValue, modulatedValue));
  }

  private resolveSemanticSequenceTarget(
    item: DirectSemanticParameterBinding,
    elapsedMs: number,
    fallbackTargetValue: number,
  ): number {
    const keyframes = item.keyframes;
    if (keyframes.length < 2) {
      return fallbackTargetValue;
    }
    let previous = keyframes[0];
    for (let index = 1; index < keyframes.length; index += 1) {
      const next = keyframes[index];
      if (elapsedMs < next.atMs) {
        return previous.targetValue;
      }
      const transitionEndMs = next.atMs + next.transitionMs;
      if (next.transitionMs > 0 && elapsedMs < transitionEndMs) {
        const progress = this.smoothstep(
          (elapsedMs - next.atMs) / next.transitionMs,
        );
        return previous.targetValue
          + (next.targetValue - previous.targetValue) * progress;
      }
      previous = next;
    }
    return previous.targetValue;
  }

  private easeOutBack(value: number): number {
    const x = Math.max(0, Math.min(1, value)) - 1;
    return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
  }

  private resolveExternalLipSyncValue(): number | null {
    if (this._externalLipSyncValue === null) {
      return null;
    }
    if (performance.now() - this._externalLipSyncUpdatedAtMs > 180) {
      this.clearExternalLipSyncValue();
      return null;
    }
    return this._externalLipSyncValue;
  }

  private resolveExternalSpeechEnergyValue(): number | null {
    if (this._externalSpeechEnergyValue === null) {
      return null;
    }
    if (performance.now() - this._externalSpeechEnergyUpdatedAtMs > 180) {
      this.clearExternalSpeechEnergyValue();
      return null;
    }
    return this._externalSpeechEnergyValue;
  }

  private resolveDynamicallyLimitedTarget(
    item: DirectSemanticParameterBinding,
    rawTargetValue: number,
    currentValue: number,
    elapsedMs: number,
    minValue: number,
    maxValue: number,
  ): number {
    if (item.maxVelocity <= 0 || item.maxAcceleration <= 0) {
      return rawTargetValue;
    }

    const previousValue = Number.isFinite(item.dynamicallyLimitedValue)
      ? Number(item.dynamicallyLimitedValue)
      : currentValue;
    const previousElapsedMs = Number.isFinite(item.lastDynamicElapsedMs)
      ? Number(item.lastDynamicElapsedMs)
      : null;
    item.lastDynamicElapsedMs = elapsedMs;

    if (previousElapsedMs === null || elapsedMs <= previousElapsedMs) {
      const initialized = this.clampNumber(previousValue, minValue, maxValue);
      item.dynamicallyLimitedValue = initialized;
      item.dynamicVelocity = 0;
      return initialized;
    }

    const deltaSeconds = Math.max(0, (elapsedMs - previousElapsedMs) / 1000);
    if (deltaSeconds <= 0) {
      return previousValue;
    }
    const next = advanceParameterDynamics(
      previousValue,
      rawTargetValue,
      item.dynamicVelocity,
      deltaSeconds,
      item.maxVelocity,
      item.maxAcceleration,
      minValue,
      maxValue,
    );
    item.dynamicallyLimitedValue = next.value;
    item.dynamicVelocity = next.velocity;
    return next.value;
  }

  private resolveSpeechFollowingChannelName(axisId: string): string {
    return axisId.startsWith("voice_following.")
      ? axisId.slice("voice_following.".length).split("|")[0]
      : axisId;
  }

  private resolveSemanticLifeMotion(
    item: DirectSemanticParameterBinding,
  ): {
    amplitude: number;
    frequencyHz: number;
  } {
    if (item.source === "supplementary") {
      return { amplitude: 0, frequencyHz: 0 };
    }
    const config = DIRECT_LIFE_MOTION_AXIS_CONFIG[item.axisId];
    if (!config) {
      return { amplitude: 0, frequencyHz: 0 };
    }
    const distance = Math.abs(item.targetValue - item.neutralTargetValue);
    if (distance <= 0.001) {
      return { amplitude: 0, frequencyHz: 0 };
    }
    const weight = Number.isFinite(item.weight) ? Math.max(0, Math.min(1, item.weight)) : 1.0;
    const amplitude = Math.min(
      config.maxAmplitude,
      Math.max(config.minAmplitude, distance * config.amplitudeRatio),
    ) * weight * item.lifeMotionScale;
    return {
      amplitude,
      frequencyHz: config.frequencyHz,
    };
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

  private resolveSpeechGestureTrackValue(
    item: DirectSemanticParameterBinding,
    elapsedMs: number,
  ): number {
    const points = item.modulationPoints;
    if (points.length < 2) {
      return 0;
    }
    const delayedElapsedMs = Math.max(0, elapsedMs - item.modulationDelayMs);
    let previous = points[0];
    for (let index = 1; index < points.length; index += 1) {
      const next = points[index];
      if (delayedElapsedMs < next.atMs) {
        return previous.value;
      }
      const transitionEndMs = next.atMs + next.transitionMs;
      if (next.transitionMs > 0 && delayedElapsedMs < transitionEndMs) {
        const progress = this.smoothstep(
          (delayedElapsedMs - next.atMs) / next.transitionMs,
        );
        return previous.value + (next.value - previous.value) * progress;
      }
      previous = next;
    }
    return previous.value;
  }

  private resolveLifeMotionPhase(axisId: string, parameterId: string): number {
    const phaseKey = `${axisId}:${parameterId}`;
    let hash = 0;
    for (let index = 0; index < phaseKey.length; index += 1) {
      hash = (hash * 31 + phaseKey.charCodeAt(index)) % 360;
    }
    return (hash / 180) * Math.PI;
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

  private resolveWritableParameter(parameterName: string): {
    parameterId: CubismIdHandle;
    parameterIndex: number;
  } | null {
    if (!this._model) {
      console.warn(`[LAppModel] resolveWritableParameter('${parameterName}'): no model`);
      return null;
    }
    const normalizedName = String(parameterName || "").trim();
    if (!normalizedName) {
      console.warn(`[LAppModel] resolveWritableParameter('${parameterName}'): empty name`);
      return null;
    }
    const idManager = CubismFramework.getIdManager();
    if (idManager) {
      const parameterId = idManager.getId(normalizedName);
      if (parameterId) {
        const parameterIndex = this._model.getParameterIndex(parameterId);
        if (this.isParameterIndexWritable(parameterIndex)) {
          if (LAppDefine.DebugLogEnable) {
            console.info(`[LAppModel] resolveWritableParameter: resolved '${normalizedName}' via idManager -> index=${parameterIndex}`);
          }
          return { parameterId, parameterIndex };
        }
        console.error(`[LAppModel] resolveWritableParameter('${parameterName}'): parameter is not writable (index=${parameterIndex}, model paramCount=${this._model.getParameterCount()}).`);
      }
    } else {
      console.error(`[LAppModel] resolveWritableParameter('${parameterName}'): Cubism id manager is unavailable.`);
    }
    console.error(`[LAppModel] resolveWritableParameter('${parameterName}'): exact parameter binding was not found.`);
    return null;
  }

  private mergeDirectParameterCalibrationProfiles(
    planProfile: DirectParameterCalibrationProfile | null,
    modelProfile: DirectParameterCalibrationProfile | null,
  ): DirectParameterCalibrationProfile | null {
    if (!planProfile && !modelProfile) {
      return null;
    }

    const axes: Record<string, DirectParameterAxisCalibration> = {};
    for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
      const mergedAxis = this.mergeDirectParameterAxisCalibration(
        planProfile?.axes?.[axisName] ?? null,
        modelProfile?.axes?.[axisName] ?? null,
      );
      if (mergedAxis) {
        axes[axisName] = mergedAxis;
      }
    }

    if (Object.keys(axes).length === 0) {
      return null;
    }

    return {
      schemaVersion: String(planProfile?.schemaVersion || modelProfile?.schemaVersion || "").trim(),
      axes,
    };
  }

  private mergeDirectParameterAxisCalibration(
    primary: DirectParameterAxisCalibration | null,
    fallback: DirectParameterAxisCalibration | null,
  ): DirectParameterAxisCalibration | null {
    if (!primary && !fallback) {
      return null;
    }

    const parameterId = String(primary?.parameterId || fallback?.parameterId || "").trim();
    const parameterIds = this.collectUniqueStrings([
      ...(primary?.parameterIds ?? []),
      ...(fallback?.parameterIds ?? []),
    ]);
    const direction = primary?.direction ?? fallback?.direction ?? null;
    const baseline = primary?.baseline ?? fallback?.baseline ?? null;
    const recommendedRange = this.mergeDirectParameterCalibrationRange(
      primary?.recommendedRange ?? null,
      fallback?.recommendedRange ?? null,
    );
    const observedRange = this.mergeDirectParameterCalibrationRange(
      primary?.observedRange ?? null,
      fallback?.observedRange ?? null,
    );
    const confidence = String(primary?.confidence || fallback?.confidence || "").trim();
    const source = String(primary?.source || fallback?.source || "").trim();
    const recommended = primary?.recommended ?? fallback?.recommended ?? null;
    const safeToApply = primary?.safeToApply ?? fallback?.safeToApply ?? null;
    const skipReason = String(primary?.skipReason || fallback?.skipReason || "").trim();

    if (
      !parameterId
      && parameterIds.length === 0
      && direction === null
      && baseline === null
      && !recommendedRange
      && !observedRange
      && !confidence
      && !source
      && recommended === null
      && safeToApply === null
      && !skipReason
    ) {
      return null;
    }

    return {
      parameterId,
      parameterIds,
      direction,
      baseline,
      recommendedRange,
      observedRange,
      confidence,
      source,
      recommended,
      safeToApply,
      skipReason,
    };
  }

  private mergeDirectParameterCalibrationRange(
    primary: DirectParameterCalibrationRange | null,
    fallback: DirectParameterCalibrationRange | null,
  ): DirectParameterCalibrationRange | null {
    if (!primary && !fallback) {
      return null;
    }

    const min = Number.isFinite(primary?.min)
      ? Number(primary?.min)
      : Number.isFinite(fallback?.min)
        ? Number(fallback?.min)
        : null;
    const max = Number.isFinite(primary?.max)
      ? Number(primary?.max)
      : Number.isFinite(fallback?.max)
        ? Number(fallback?.max)
        : null;

    if (min === null && max === null) {
      return null;
    }

    if (min !== null && max !== null) {
      return min <= max ? { min, max } : { min: max, max: min };
    }

    return { min, max };
  }

  private collectUniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values) {
      const item = String(value || "").trim();
      if (!item) {
        continue;
      }
      const key = item.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(item);
    }
    return normalized;
  }

  private resolveAxisCalibration(
    axisName: string,
    profile: DirectParameterCalibrationProfile | null,
    parameterName: string,
  ): DirectParameterAxisCalibration | null {
    const calibration = profile?.axes?.[axisName];
    if (!calibration) {
      return null;
    }

    if (!calibration.parameterId && calibration.parameterIds.length === 0) {
      return calibration;
    }

    const normalizedParameterName = String(parameterName || "").trim().toLowerCase();
    if (!normalizedParameterName) {
      return calibration;
    }

    const matchesPrimary = calibration.parameterId.toLowerCase() === normalizedParameterName;
    const matchesAlias = calibration.parameterIds.some((item) => item.toLowerCase() === normalizedParameterName);
    if (matchesPrimary || matchesAlias) {
      return calibration;
    }
    return null;
  }

  private resolveAxisParameterCandidates(
    axisName: string,
    profile: DirectParameterCalibrationProfile | null,
  ): string[] {
    const candidates: string[] = [];
    const calibration = profile?.axes?.[axisName];
    if (calibration) {
      if (calibration.parameterId) {
        candidates.push(calibration.parameterId);
      }
      for (const parameterId of calibration.parameterIds) {
        candidates.push(parameterId);
      }
    }
    for (const fallbackName of DIRECT_PARAMETER_AXIS_MAP[axisName] ?? []) {
      candidates.push(fallbackName);
    }
    return this.collectUniqueStrings(candidates);
  }

  private normalizeDirectParameterCalibrationProfile(
    value: unknown,
  ): DirectParameterCalibrationProfile | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const payload = value as Record<string, any>;
    const axesPayload = payload.axes && typeof payload.axes === "object" && !Array.isArray(payload.axes)
      ? payload.axes
      : payload.axis_calibrations && typeof payload.axis_calibrations === "object" && !Array.isArray(payload.axis_calibrations)
        ? payload.axis_calibrations
        : payload;

    const axes: Record<string, DirectParameterAxisCalibration> = {};
    for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
      const normalizedAxis = this.normalizeDirectParameterAxisCalibration(
        axesPayload?.[axisName],
      );
      if (!normalizedAxis) {
        continue;
      }
      axes[axisName] = normalizedAxis;
    }

    if (Object.keys(axes).length === 0) {
      return null;
    }

    return {
      schemaVersion: String(payload.schema_version || "").trim(),
      axes,
    };
  }

  private normalizeDirectParameterAxisCalibration(
    value: unknown,
  ): DirectParameterAxisCalibration | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const payload = value as Record<string, any>;
    const parameterId = String(payload.parameter_id || "").trim();
    const parameterIds = Array.isArray(payload.parameter_ids)
      ? payload.parameter_ids
        .map((item) => String(item || "").trim())
        .filter((item) => item.length > 0)
      : [];
    const direction = this.normalizeDirectParameterDirection(payload.direction);
    const baseline = Number.isFinite(payload.baseline)
      ? Number(payload.baseline)
      : null;
    const recommendedRange = this.normalizeDirectParameterCalibrationRange(
      payload.recommended_range ?? payload.recommended ?? payload.recommendedRange,
    );
    const observedRange = this.normalizeDirectParameterCalibrationRange(
      payload.observed_range ?? payload.observed ?? payload.observedRange,
    );
    const confidence = String(payload.confidence || "").trim();
    const source = String(payload.source || "").trim();
    const recommended = typeof payload.recommended === "boolean"
      ? payload.recommended
      : null;
    const safeToApply = typeof payload.safe_to_apply === "boolean"
      ? payload.safe_to_apply
      : null;
    const skipReason = String(payload.skip_reason || "").trim();

    if (
      !parameterId
      && parameterIds.length === 0
      && direction === null
      && baseline === null
      && !recommendedRange
      && !observedRange
      && !confidence
      && !source
      && recommended === null
      && safeToApply === null
      && !skipReason
    ) {
      return null;
    }

    return {
      parameterId,
      parameterIds,
      direction,
      baseline,
      recommendedRange,
      observedRange,
      confidence,
      source,
      recommended,
      safeToApply,
      skipReason,
    };
  }

  private normalizeDirectParameterDirection(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
      return value < 0 ? -1 : 1;
    }
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (["-1", "negative", "invert", "inverted", "reverse", "reversed"].includes(normalized)) {
      return -1;
    }
    if (["1", "positive", "forward", "normal"].includes(normalized)) {
      return 1;
    }
    return null;
  }

  private normalizeDirectParameterCalibrationRange(
    value: unknown,
  ): DirectParameterCalibrationRange | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const payload = value as Record<string, any>;
    const min = Number.isFinite(payload.min) ? Number(payload.min) : null;
    const max = Number.isFinite(payload.max) ? Number(payload.max) : null;
    if (min === null && max === null) {
      return null;
    }

    if (min !== null && max !== null) {
      return min <= max ? { min, max } : { min: max, max: min };
    }

    return { min, max };
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
    this._speechAudioEnvelope = 0.0;
    this._speechBodyEnvelope = 0.0;
    this._externalLipSyncValue = null;
    this._externalLipSyncUpdatedAtMs = 0;
    this._externalSpeechEnergyValue = null;
    this._externalSpeechEnergyUpdatedAtMs = 0;
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
  _speechAudioEnvelope: number;
  _speechBodyEnvelope: number;
  _externalLipSyncValue: number | null;
  _externalLipSyncUpdatedAtMs: number;
  _externalSpeechEnergyValue: number | null;
  _externalSpeechEnergyUpdatedAtMs: number;
}
