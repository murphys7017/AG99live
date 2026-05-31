// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).performance = {
  now: () => mockNowMs,
};

import assert from "node:assert/strict";
import { effectScope } from "vue";
import { usePreviewMotionPlayer } from "../src/live2d-renderer/usePreviewMotionPlayer.js";
import type { CatalogMotionPayload, SemanticParameterPlan } from "../src/types/protocol.js";

let mockNowMs = 1000;

function buildPlan(): SemanticParameterPlan {
  return {
    schema_version: "engine.parameter_plan.v2",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    timing: {
      duration_ms: 1200,
      blend_in_ms: 120,
      hold_ms: 860,
      blend_out_ms: 220,
    },
    parameters: [
      {
        axis_id: "head_yaw",
        parameter_id: "ParamAngleX",
        target_value: 10,
        weight: 1,
        input_value: 70,
        source: "semantic_axis",
      },
    ],
    diagnostics: {
      warnings: [],
    },
    summary: {
      axis_count: 1,
      parameter_count: 1,
    },
  };
}

function buildCatalogMotion(durationMs: number | null = 3000): CatalogMotionPayload {
  return {
    schema_version: "engine.catalog_motion.v1",
    model_id: "model-1",
    motion_id: "serious_explain",
    group: "TapBody",
    index: 0,
    file: "Motions/serious.motion3.json",
    label: "认真说明",
    emotion_label: "explain",
    duration_ms: durationMs,
    priority: 3,
  };
}

function installMockAdapter(): { startCount: () => number } {
  let startDirectParameterPlanCount = 0;
  (globalThis as typeof globalThis & {
    getLAppAdapter?: () => {
      startDirectParameterPlan: (plan: SemanticParameterPlan) => boolean;
      stopDirectParameterPlan: () => void;
      getDirectParameterPlanError: () => string;
    };
  }).getLAppAdapter = () => ({
    startDirectParameterPlan: () => {
      startDirectParameterPlanCount += 1;
      return true;
    },
    stopDirectParameterPlan: () => {},
    getDirectParameterPlanError: () => "",
  });
  return {
    startCount: () => startDirectParameterPlanCount,
  };
}

function installCatalogMockAdapter(startMotionResult: number): { startMotionCount: () => number } {
  let startMotionCount = 0;
  (globalThis as typeof globalThis & {
    getLAppAdapter?: () => {
      startMotion: (group: string, no: number, priority: number, onFinished?: () => void) => number;
      stopDirectParameterPlan: () => void;
    };
  }).getLAppAdapter = () => ({
    startMotion: () => {
      startMotionCount += 1;
      return startMotionResult;
    },
    stopDirectParameterPlan: () => {},
  });
  return {
    startMotionCount: () => startMotionCount,
  };
}

async function testSoftHandoffDuplicateStillReportsStarted(): Promise<void> {
  const adapter = installMockAdapter();
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const startedPlans: SemanticParameterPlan[] = [];
  const plan = buildPlan();

  mockNowMs = 1000;
  assert.equal(player.playPlan(plan, null, {
    softHandoff: true,
    onStarted: (startedPlan) => {
      startedPlans.push(startedPlan);
    },
  }), true);

  mockNowMs = 1200;
  assert.equal(player.playPlan(plan, null, {
    softHandoff: true,
    onStarted: (startedPlan) => {
      startedPlans.push(startedPlan);
    },
  }), true);

  assert.equal(adapter.startCount(), 1);
  assert.equal(startedPlans.length, 2);
  assert.equal(startedPlans[1].emotion_label, "happy");
  scope.stop();
}

async function testCatalogMotionAsyncHandleWithDurationIsAccepted(): Promise<void> {
  const adapter = installCatalogMockAdapter(-1);
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);

  assert.equal(player.playCatalogMotion(buildCatalogMotion(3000), null), true);
  assert.equal(adapter.startMotionCount(), 1);
  assert.equal(player.state.status, "playing");
  scope.stop();
}

async function testCatalogMotionInvalidHandleWithoutDurationStillFails(): Promise<void> {
  installCatalogMockAdapter(-1);
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);

  assert.equal(player.playCatalogMotion(buildCatalogMotion(null), null), false);
  assert.equal(player.state.status, "failed");
  scope.stop();
}

async function run(): Promise<void> {
  await testSoftHandoffDuplicateStillReportsStarted();
  await testCatalogMotionAsyncHandleWithDurationIsAccepted();
  await testCatalogMotionInvalidHandleWithoutDurationStillFails();
  console.log("previewMotionPlayer tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
