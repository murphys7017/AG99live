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
import { TextureInfo } from "./lapptexturemanager";
import { LAppWavFileHandler } from "./lappwavfilehandler";
import { CubismMoc } from "@framework/model/cubismmoc";

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
  body_roll: ["ParamBodyAngleZ", "PARAM_BODY_ANGLE_Z", "ParamBodyAngleY", "PARAM_BODY_ANGLE_Y"],
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

interface DirectParameterAxisBinding {
  axisName: string;
  axisValue: number;
  parameterName: string;
  parameterId: CubismIdHandle;
  parameterIndex: number;
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

interface DirectParameterPlanState {
  mode: "expressive" | "idle";
  emotionLabel: string;
  timing: {
    durationMs: number;
    blendInMs: number;
    holdMs: number;
    blendOutMs: number;
    totalMs: number;
  };
  axisBindings: DirectParameterAxisBinding[];
  supplementaryBindings: DirectSupplementaryBinding[];
  startedAtMs: number;
}

/**
 * ユーザーが実際に使用するモデルの実装クラス<br>
 * モデル生成、機能コンポーネント生成、更新処理とレンダリングの呼び出しを行う。
 */
export class LAppModel extends CubismUserModel {
  /**
   * model3.jsonが置かれたディレクトリとファイルパスからモデルを生成する
   * @param dir
   * @param fileName
   */
  public loadAssets(dir: string, fileName: string): void {
    this._modelHomeDir = dir;

    fetch(`${this._modelHomeDir}${fileName}`)
      .then((response) => response.arrayBuffer())
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
        // model3.json読み込みでエラーが発生した時点で描画は不可能なので、setupせずエラーをcatchして何もしない
        CubismLogError(`Failed to load file ${this._modelHomeDir}${fileName}`);
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

      fetch(`${this._modelHomeDir}${modelFileName}`)
        .then((response) => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${modelFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then((arrayBuffer) => {
          this.loadModel(arrayBuffer, this._mocConsistency, LAppDefine.CurrentKScale);
          this._state = LoadStep.LoadExpression;

          // callback
          loadCubismExpression();
        });

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

          fetch(`${this._modelHomeDir}${expressionFileName}`)
            .then((response) => {
              if (response.ok) {
                return response.arrayBuffer();
              } else if (response.status >= 400) {
                CubismLogError(
                  `Failed to load file ${this._modelHomeDir}${expressionFileName}`
                );
                // ファイルが存在しなくてもresponseはnullを返却しないため、空のArrayBufferで対応する
                return new ArrayBuffer(0);
              }
            })
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
            });
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

        fetch(`${this._modelHomeDir}${physicsFileName}`)
          .then((response) => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${physicsFileName}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then((arrayBuffer) => {
            this.loadPhysics(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.LoadPose;

            // callback
            loadCubismPose();
          });
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

        fetch(`${this._modelHomeDir}${poseFileName}`)
          .then((response) => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${poseFileName}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then((arrayBuffer) => {
            this.loadPose(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlink;

            // callback
            setupEyeBlink();
          });
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

        fetch(`${this._modelHomeDir}${userDataFile}`)
          .then((response) => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${userDataFile}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then((arrayBuffer) => {
            this.loadUserData(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlinkIds;

            // callback
            setupEyeBlinkIds();
          });

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
        const fallbackLipSyncIds = this.findLipSyncFallbackIds();

        for (const fallbackLipSyncId of fallbackLipSyncIds) {
          this._lipSyncIds.pushBack(fallbackLipSyncId);
        }

        if (LAppDefine.DebugLogEnable && fallbackLipSyncIds.length > 0) {
          console.info(
            '[Fallback] Added lip sync fallback parameter ids:',
            fallbackLipSyncIds.map((id) => id?.getString?.().s ?? '<unknown>'),
          );
        }
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
          console.log("getTextureFileName null");
          continue;
        }

        // WebGLのテクスチャユニットにテクスチャをロードする
        let texturePath =
          this._modelSetting.getTextureFileName(modelTextureNumber);
        texturePath = this._modelHomeDir + texturePath;

        // ロード完了時に呼び出すコールバック関数
        const onLoad = (textureInfo: TextureInfo): void => {
          this.getRenderer().bindTexture(modelTextureNumber, textureInfo.id);

          this._textureCount++;

          if (this._textureCount >= textureCount) {
            // ロード完了
            this._state = LoadStep.CompleteSetup;
          }
        };

        // 読み込み
        LAppDelegate.getInstance()
          .getTextureManager()
          .createTextureFromPngFile(texturePath, usePremultiply, onLoad);
        this.getRenderer().setIsPremultipliedAlpha(usePremultiply);
      }

      this._state = LoadStep.WaitLoadTexture;
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

    this._dragManager.update(deltaTimeSeconds);
    this._dragX = this._dragManager.getX();
    this._dragY = this._dragManager.getY();

    // モーションによるパラメータ更新の有無
    let motionUpdated = false;

    //--------------------------------------------------------------------------
    this._model.loadParameters(); // 前回セーブされた状態をロード
    if (this._motionManager.isFinished()) {
      // モーションの再生がない場合、待機モーションの中からランダムで再生する
      this.startRandomMotion(
        LAppDefine.MotionGroupIdle,
        LAppDefine.PriorityIdle
      );
    } else {
      motionUpdated = this._motionManager.updateMotion(
        this._model,
        deltaTimeSeconds
      ); // モーションを更新
    }
    this._model.saveParameters(); // 状態を保存
    //--------------------------------------------------------------------------

    // まばたき
    if (!motionUpdated) {
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
    if (this._breath != null) {
      this._breath.updateParameters(this._model, deltaTimeSeconds);
    }

    // 物理演算の設定
    if (this._physics != null) {
      this._physics.evaluate(this._model, deltaTimeSeconds);
    }

    // Lip sync settings
    if (this._lipsync) {
      let value = 0.0;
      this._wavFileHandler.update(deltaTimeSeconds);
      value = this._wavFileHandler.getRms();
      value = Math.min(1.0, value * 1.5);

      const lipSyncWeight = 4.0;

      for (let i = 0; i < this._lipSyncIds.getSize(); ++i) {
        this._model.addParameterValueById(
          this._lipSyncIds.at(i),
          value,
          lipSyncWeight
        );
      }
    }

    // ポーズの設定
    if (this._pose != null) {
      this._pose.updateParameters(this._model, deltaTimeSeconds);
    }

    const directPlanFailure = this.applyDirectParameterPlanOverlay();
    if (directPlanFailure) {
      this.stopDirectParameterPlan(directPlanFailure);
    }

    this._model.update();
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
    onFinishedMotionHandler?: FinishedMotionCallback
  ): CubismMotionQueueEntryHandle {
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
      return InvalidMotionQueueEntryHandleValue;
    }

    const motionFileName = this._modelSetting.getMotionFileName(group, no);

    // ex) idle_0 or _0 if group is ""
    const name = `${group}_${no}`;
    let motion: CubismMotion = this._motions.getValue(name) as CubismMotion;
    let autoDelete = false;

    if (motion == null) {
      if (LAppDefine.DebugLogEnable) {
        console.log(`[APP] startMotion: Motion '${name}' not found in cache, fetching: ${motionFileName}`);
      }
      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then((response) => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${motionFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then((arrayBuffer) => {
          motion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            null, // Pass null for name here? Original code did. Let's keep it for now.
            onFinishedMotionHandler
          );

          if (motion == null) {
             if (LAppDefine.DebugLogEnable) {
                console.error(`[APP] startMotion: Failed to load motion from fetched data for '${name}'`);
             }
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
          autoDelete = true; // 終了時にメモリから削除

          // Start the motion *after* it's loaded (moved from outside)
          if (LAppDefine.DebugLogEnable) {
            console.log(`[APP] startMotion: Starting fetched motion '${name}'`);
          }
          this._motionManager.startMotionPriority(
            motion,
            autoDelete,
            priority
          );
        });
      // Return InvalidHandle immediately because the motion starts asynchronously
      // This might be an issue if the caller expects a valid handle right away.
      // Let's reconsider this. Maybe startMotion should return a Promise? For now, keep original logic.
       return InvalidMotionQueueEntryHandleValue; 
    } else {
      if (LAppDefine.DebugLogEnable) {
        console.log(`[APP] startMotion: Motion '${name}' found in cache. Starting.`);
      }
      motion.setFinishedMotionHandler(onFinishedMotionHandler);
      // Start the motion if found in cache
      return this._motionManager.startMotionPriority(
          motion,
          autoDelete, // Should be false for cached motions? Let's assume true based on original code.
          priority
      );
    }

    // Original code had voice logic and startMotionPriority call here, moved inside blocks
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
  public setExpression(expressionId: string): void {
    const motion: ACubismMotion = this._expressions.getValue(expressionId);

    if (this._debugMode) {
      LAppPal.printMessage(`[APP]expression: [${expressionId}]`);
    }

    if (motion != null) {
      this._expressionManager.startMotionPriority(
        motion,
        false,
        LAppDefine.PriorityForce
      );
    } else {
      if (this._debugMode) {
        LAppPal.printMessage(`[APP]expression[${expressionId}] is null`);
      }
    }
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

  private findLipSyncFallbackIds(): CubismIdHandle[] {
    const fallbackIds: CubismIdHandle[] = [];
    const seen = new Set<string>();
    const idManager = CubismFramework.getIdManager();

    const pushIfValid = (parameterId: CubismIdHandle | null) => {
      if (!parameterId || !this.hasModelParameter(parameterId)) {
        return;
      }

      const key = parameterId.getString?.().s ?? '';
      if (!key || seen.has(key)) {
        return;
      }

      seen.add(key);
      fallbackIds.push(parameterId);
    };

    if (idManager) {
      [
        CubismDefaultParameterId.ParamMouthOpenY,
        'PARAM_MOUTH_OPEN_Y',
        'ParamMouthOpen',
        'PARAM_MOUTH_OPEN',
      ].forEach((parameterName) => {
        pushIfValid(idManager.getId(parameterName));
      });
    }

    if (fallbackIds.length > 0) {
      return fallbackIds;
    }

    const parameterIds = this._model?._parameterIds;
    const parameterCount = this._model?.getParameterCount?.() ?? 0;
    for (let i = 0; i < parameterCount; i += 1) {
      const parameterId = parameterIds?.at?.(i) ?? null;
      const parameterName = parameterId?.getString?.().s ?? '';

      if (!/(mouth.*open|open.*mouth)/i.test(parameterName)) {
        continue;
      }

      pushIfValid(parameterId);
    }

    if (LAppDefine.DebugLogEnable && fallbackIds.length === 0) {
      console.info('[Fallback] No usable lip sync parameter ids were found on the model.');
    }

    return fallbackIds;
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

      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then((response) => {
          if (response.ok) {
            return response.arrayBuffer();
          }

          throw new Error(`Failed to load file ${this._modelHomeDir}${motionFileName}`);
        })
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
          CubismLogError(`Failed to load motion: ${error}`);
          this._updating = false;
          this._initialized = false;
          throw error;
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

  public startDirectParameterPlan(plan: unknown): boolean {
    const parsed = this.parseDirectParameterPlan(plan);
    if (!parsed.plan) {
      this.stopDirectParameterPlan(parsed.reason || "invalid_plan");
      return false;
    }
    if (!this._model || this._state != LoadStep.CompleteSetup) {
      this.stopDirectParameterPlan("model_not_ready");
      return false;
    }

    const axisBindings: DirectParameterAxisBinding[] = [];
    for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
      const axisConfig = parsed.plan.key_axes[axisName];
      const axisValue = Number(axisConfig?.value ?? 50);
      const candidates = DIRECT_PARAMETER_AXIS_MAP[axisName] ?? [];
      let resolvedBinding: DirectParameterAxisBinding | null = null;

      for (const parameterName of candidates) {
        const resolved = this.resolveWritableParameter(parameterName);
        if (!resolved) {
          continue;
        }
        resolvedBinding = {
          axisName,
          axisValue,
          parameterName,
          parameterId: resolved.parameterId,
          parameterIndex: resolved.parameterIndex,
        };
        break;
      }

      if (!resolvedBinding) {
        this.stopDirectParameterPlan(`missing_axis_parameter:${axisName}`);
        return false;
      }
      axisBindings.push(resolvedBinding);
    }

    const supplementaryBindings: DirectSupplementaryBinding[] = [];
    for (const item of parsed.plan.supplementary_params) {
      const parameterIdRaw = String(item.parameter_id || "").trim();
      const sourceAtomId = String(item.source_atom_id || "").trim();
      const channel = String(item.channel || "").trim();
      const resolved = this.resolveWritableParameter(parameterIdRaw);
      if (!resolved) {
        this.stopDirectParameterPlan(`missing_supplementary_parameter:${parameterIdRaw}`);
        return false;
      }

      supplementaryBindings.push({
        parameterIdRaw,
        targetValue: Number(item.target_value || 0),
        weight: Number(item.weight || 0),
        sourceAtomId,
        channel,
        parameterId: resolved.parameterId,
        parameterIndex: resolved.parameterIndex,
      });
    }

    this._directParameterPlanState = {
      mode: parsed.plan.mode,
      emotionLabel: parsed.plan.emotion_label,
      timing: parsed.timing,
      axisBindings,
      supplementaryBindings,
      startedAtMs: performance.now(),
    };
    this._directParameterPlanError = "";
    return true;
  }

  public stopDirectParameterPlan(reason = ""): void {
    this._directParameterPlanState = null;
    this._directParameterPlanError = reason ? String(reason) : "";
    if (this._directParameterPlanError) {
      console.error(`[APP] Direct parameter plan stopped: ${this._directParameterPlanError}`);
    }
  }

  public getDirectParameterPlanError(): string {
    return this._directParameterPlanError || "";
  }

  public async loadWavFileForLipSync(url: string): Promise<boolean> {
    try {
      await this._wavFileHandler.loadWavFile(url);
      this._wavFileHandler.resetPlaybackCursor();
      return true;
    } catch (e) {
      console.warn("[LAppModel] Failed to load wav for lip sync:", e);
      return false;
    }
  }

  private applyDirectParameterPlanOverlay(): string | null {
    if (!this._directParameterPlanState || !this._model) {
      return null;
    }

    const planState = this._directParameterPlanState;
    const elapsedMs = Math.max(0, performance.now() - planState.startedAtMs);
    const easing = this.resolvePlanEasing(elapsedMs, planState.timing);

    for (const axis of planState.axisBindings) {
      if (!this.isParameterIndexWritable(axis.parameterIndex)) {
        return `axis_parameter_not_writable:${axis.axisName}`;
      }

      const minValue = this._model.getParameterMinimumValue(axis.parameterIndex);
      const maxValue = this._model.getParameterMaximumValue(axis.parameterIndex);
      const baseValue = this._model.getParameterValueByIndex(axis.parameterIndex);
      const targetValue = minValue + (maxValue - minValue) * (axis.axisValue / 100.0);
      let blendedValue = baseValue + (targetValue - baseValue) * easing;

      // Keep speech lip sync dominant on mouth opening while audio is playing.
      if (this._lipsync && axis.axisName === "mouth_open") {
        blendedValue = Math.max(baseValue, blendedValue);
      }

      this._model.setParameterValueById(axis.parameterId, blendedValue);
    }

    for (const item of planState.supplementaryBindings) {
      if (!this.isParameterIndexWritable(item.parameterIndex)) {
        return `supplementary_parameter_not_writable:${item.parameterIdRaw}`;
      }

      const minValue = this._model.getParameterMinimumValue(item.parameterIndex);
      const maxValue = this._model.getParameterMaximumValue(item.parameterIndex);
      const range = maxValue - minValue;
      const delta = item.targetValue * 0.5 * range * item.weight * easing;
      this._model.addParameterValueById(item.parameterId, delta);
    }

    if (elapsedMs >= planState.timing.totalMs) {
      this.stopDirectParameterPlan();
    }
    return null;
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
      return this.smoothstep(elapsed / blendInMs);
    }
    if (elapsed < blendInMs + holdMs) {
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
      return null;
    }
    const normalizedName = String(parameterName || "").trim();
    if (!normalizedName) {
      return null;
    }
    const idManager = CubismFramework.getIdManager();
    if (!idManager) {
      return null;
    }
    const parameterId = idManager.getId(normalizedName);
    if (!parameterId) {
      return null;
    }
    const parameterIndex = this._model.getParameterIndex(parameterId);
    if (!this.isParameterIndexWritable(parameterIndex)) {
      return null;
    }
    return { parameterId, parameterIndex };
  }

  private parseDirectParameterPlan(plan: unknown): {
    plan: {
      mode: "expressive" | "idle";
      emotion_label: string;
      timing: {
        duration_ms: number;
        blend_in_ms: number;
        hold_ms: number;
        blend_out_ms: number;
      };
      key_axes: Record<string, { value: number }>;
      supplementary_params: Array<{
        parameter_id: string;
        target_value: number;
        weight: number;
        source_atom_id: string;
        channel: string;
      }>;
    } | null;
    timing: DirectParameterPlanState["timing"];
    reason: string;
  } {
    const fail = (reason: string) => ({
      plan: null,
      timing: {
        durationMs: 0,
        blendInMs: 0,
        holdMs: 0,
        blendOutMs: 0,
        totalMs: 0,
      },
      reason,
    });

    if (!plan || typeof plan !== "object") {
      return fail("plan_not_object");
    }

    const payload = plan as Record<string, any>;
    if (String(payload.schema_version || "").trim() !== "engine.parameter_plan.v1") {
      return fail("invalid_schema_version");
    }

    const mode = String(payload.mode || "").trim().toLowerCase();
    if (mode !== "expressive" && mode !== "idle") {
      return fail("invalid_mode");
    }

    const timingPayload = payload.timing;
    if (!timingPayload || typeof timingPayload !== "object") {
      return fail("timing_not_object");
    }
    const durationMs = Number(timingPayload.duration_ms);
    const blendInMs = Number(timingPayload.blend_in_ms);
    const holdMs = Number(timingPayload.hold_ms);
    const blendOutMs = Number(timingPayload.blend_out_ms);
    if (
      !Number.isFinite(durationMs)
      || !Number.isFinite(blendInMs)
      || !Number.isFinite(holdMs)
      || !Number.isFinite(blendOutMs)
    ) {
      return fail("timing_not_number");
    }
    if (durationMs < 0 || blendInMs < 0 || holdMs < 0 || blendOutMs < 0) {
      return fail("timing_negative");
    }

    const keyAxesPayload = payload.key_axes;
    if (!keyAxesPayload || typeof keyAxesPayload !== "object") {
      return fail("key_axes_not_object");
    }
    const keyAxes: Record<string, { value: number }> = {};
    for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
      const axisPayload = keyAxesPayload[axisName];
      if (!axisPayload || typeof axisPayload !== "object") {
        return fail(`missing_axis:${axisName}`);
      }
      const axisValue = Number(axisPayload.value);
      if (!Number.isFinite(axisValue)) {
        return fail(`axis_value_not_number:${axisName}`);
      }
      if (axisValue < 0 || axisValue > 100) {
        return fail(`axis_value_out_of_range:${axisName}`);
      }
      keyAxes[axisName] = { value: axisValue };
    }

    const supplementaryPayload = payload.supplementary_params;
    if (!Array.isArray(supplementaryPayload)) {
      return fail("supplementary_not_list");
    }
    const supplementaryParams: Array<{
      parameter_id: string;
      target_value: number;
      weight: number;
      source_atom_id: string;
      channel: string;
    }> = [];
    for (const item of supplementaryPayload) {
      if (!item || typeof item !== "object") {
        return fail("supplementary_item_not_object");
      }
      const parameterId = String(item.parameter_id || "").trim();
      const sourceAtomId = String(item.source_atom_id || "").trim();
      const channel = String(item.channel || "").trim();
      const targetValue = Number(item.target_value);
      const weight = Number(item.weight);
      if (!parameterId || !sourceAtomId || !channel) {
        return fail("supplementary_required_field_missing");
      }
      if (!Number.isFinite(targetValue) || !Number.isFinite(weight)) {
        return fail("supplementary_not_number");
      }
      if (targetValue < -1 || targetValue > 1) {
        return fail("supplementary_target_value_out_of_range");
      }
      if (weight < 0 || weight > 1) {
        return fail("supplementary_weight_out_of_range");
      }
      supplementaryParams.push({
        parameter_id: parameterId,
        target_value: targetValue,
        weight,
        source_atom_id: sourceAtomId,
        channel,
      });
    }

    const timing = {
      durationMs: Math.round(durationMs),
      blendInMs: Math.round(blendInMs),
      holdMs: Math.round(holdMs),
      blendOutMs: Math.round(blendOutMs),
      totalMs: Math.max(
        Math.round(durationMs),
        Math.round(blendInMs + holdMs + blendOutMs),
      ),
    };

    return {
      plan: {
        mode,
        emotion_label: String(payload.emotion_label || "neutral").trim() || "neutral",
        timing: {
          duration_ms: timing.durationMs,
          blend_in_ms: timing.blendInMs,
          hold_ms: timing.holdMs,
          blend_out_ms: timing.blendOutMs,
        },
        key_axes: keyAxes,
        supplementary_params: supplementaryParams,
      },
      timing,
      reason: "",
    };
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
    this._wavFileHandler = new LAppWavFileHandler();
    this._consistency = false;
    this._directParameterPlanState = null;
    this._directParameterPlanError = "";
  }

  _modelSetting: ICubismModelSetting; // モデルセッティング情報
  _modelHomeDir: string; // モデルセッティングが置かれたディレクトリ
  _userTimeSeconds: number; // デルタ時間の積算値[秒]

  _eyeBlinkIds: csmVector<CubismIdHandle>; // モデルに設定された瞬き機能用パラメータID
  _lipSyncIds: csmVector<CubismIdHandle>; // モデルに設定されたリップシンク機能用パラメータID

  _motions: csmMap<string, ACubismMotion>; // 読み込まれているモーションのリスト
  _expressions: csmMap<string, ACubismMotion>; // 読み込まれている表情のリスト

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
  _wavFileHandler: LAppWavFileHandler; //wavファイルハンドラ
  _consistency: boolean; // MOC3一貫性チェック管理用
  _directParameterPlanState: DirectParameterPlanState | null;
  _directParameterPlanError: string;
}
