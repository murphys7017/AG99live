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

function installCatalogMockAdapter(
  startMotionResult: unknown,
  options: { finishImmediately?: boolean; motionStartError?: string } = {},
): { startMotionCount: () => number } {
  let startMotionCount = 0;
  (globalThis as typeof globalThis & {
    getLAppAdapter?: () => {
      startMotion: (group: string, no: number, priority: number, onFinished?: () => void) => unknown;
      getMotionStartError: () => string;
      stopDirectParameterPlan: () => void;
    };
  }).getLAppAdapter = () => ({
    startMotion: (_group, _no, _priority, onFinished) => {
      startMotionCount += 1;
      if (options.finishImmediately) {
        queueMicrotask(() => onFinished?.());
      }
      return startMotionResult;
    },
    getMotionStartError: () => options.motionStartError ?? "",
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

async function testCatalogMotionInvalidHandleWithDurationFails(): Promise<void> {
  const adapter = installCatalogMockAdapter(-1, { motionStartError: "motion_start_rejected" });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);

  assert.equal(player.playCatalogMotion(buildCatalogMotion(3000), null), false);
  assert.equal(adapter.startMotionCount(), 1);
  assert.equal(player.state.status, "failed");
  assert.match(player.state.message, /motion_start_rejected/);
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

async function testCatalogMotionAsyncAcceptedFailureReportsFailed(): Promise<void> {
  const adapter = installCatalogMockAdapter(
    { status: "async_motion_accepted" },
    { finishImmediately: true, motionStartError: "motion_fetch_failed" },
  );
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);

  assert.equal(player.playCatalogMotion(buildCatalogMotion(3000), null), true);
  await Promise.resolve();
  assert.equal(adapter.startMotionCount(), 1);
  assert.equal(player.state.status, "failed");
  assert.match(player.state.message, /motion_fetch_failed/);
  scope.stop();
}

async function testCatalogMotionReportsStartedAndCompletedCallbacks(): Promise<void> {
  installCatalogMockAdapter(
    { status: "async_motion_accepted" },
    { finishImmediately: true },
  );
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const startedRunIds: string[] = [];
  const finished: Array<{ runId: string; status: string; reason?: string }> = [];

  assert.equal(player.playCatalogMotion(buildCatalogMotion(3000), null, {
    onStarted: (_motion, runId) => {
      if (runId) {
        startedRunIds.push(runId);
      }
    },
    onFinished: (event) => {
      finished.push(event);
    },
  }), true);
  await Promise.resolve();

  assert.equal(startedRunIds.length, 1);
  assert.deepEqual(finished, [
    {
      runId: startedRunIds[0],
      status: "completed",
    },
  ]);
  scope.stop();
}

async function testDirectPlanStopReportsStoppedTerminalOnce(): Promise<void> {
  installMockAdapter();
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const startedRunIds: string[] = [];
  const finished: Array<{ runId: string; status: string; reason?: string }> = [];

  assert.equal(player.playPlan(buildPlan(), null, {
    softHandoff: true,
    onStarted: (_plan, runId) => {
      if (runId) {
        startedRunIds.push(runId);
      }
    },
    onFinished: (event) => {
      finished.push(event);
    },
  }), true);

  assert.equal(startedRunIds.length, 1);
  player.stopPlan("manual_stop");
  scope.stop();

  assert.deepEqual(finished, [
    {
      runId: startedRunIds[0],
      status: "stopped",
      reason: "manual_stop",
    },
  ]);
}

async function run(): Promise<void> {
  await testSoftHandoffDuplicateStillReportsStarted();
  await testCatalogMotionInvalidHandleWithDurationFails();
  await testCatalogMotionInvalidHandleWithoutDurationStillFails();
  await testCatalogMotionAsyncAcceptedFailureReportsFailed();
  await testCatalogMotionReportsStartedAndCompletedCallbacks();
  await testDirectPlanStopReportsStoppedTerminalOnce();
  console.log("previewMotionPlayer tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
