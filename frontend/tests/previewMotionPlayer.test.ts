// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope } from "vue";
import { usePreviewMotionPlayer } from "../src/live2d-renderer/usePreviewMotionPlayer.js";
import type { CatalogMotionPayload, SemanticParameterPlan } from "../src/types/protocol.js";

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
        neutral_target_value: 0,
        weight: 1,
        input_value: 70,
        source: "semantic_axis",
        dynamics: {
          max_velocity: 72,
          max_acceleration: 360,
          life_motion_scale: 0.5,
          max_speech_offset: 3,
        },
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

function installMockAdapter(): {
  startCount: () => number;
  stopCount: () => number;
  stopEvents: () => Array<{ reason?: string; status?: string }>;
} {
  let startDirectParameterPlanCount = 0;
  let stopDirectParameterPlanCount = 0;
  const directPlanStopEvents: Array<{ reason?: string; status?: string }> = [];
  (globalThis as typeof globalThis & {
    getLAppAdapter?: () => {
      startDirectParameterPlan: (plan: SemanticParameterPlan) => boolean;
      stopDirectParameterPlan: (reason?: string, status?: string) => void;
      getDirectParameterPlanError: () => string;
    };
  }).getLAppAdapter = () => ({
    startDirectParameterPlan: () => {
      startDirectParameterPlanCount += 1;
      return true;
    },
    stopDirectParameterPlan: (reason, status) => {
      stopDirectParameterPlanCount += 1;
      directPlanStopEvents.push({ reason, status });
    },
    getDirectParameterPlanError: () => "",
  });
  return {
    startCount: () => startDirectParameterPlanCount,
    stopCount: () => stopDirectParameterPlanCount,
    stopEvents: () => [...directPlanStopEvents],
  };
}

function installCatalogMockAdapter(
  startMotionResult: unknown,
  options: { finishImmediately?: boolean; motionStartError?: string } = {},
): { startMotionCount: () => number; stopMotionCount: () => number } {
  let startMotionCount = 0;
  let stopMotionCount = 0;
  (globalThis as typeof globalThis & {
    getLAppAdapter?: () => {
      startMotion: (group: string, no: number, priority: number, onFinished?: () => void) => unknown;
      stopMotion: () => void;
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
    stopMotion: () => {
      stopMotionCount += 1;
    },
    getMotionStartError: () => options.motionStartError ?? "",
    stopDirectParameterPlan: () => {},
  });
  return {
    startMotionCount: () => startMotionCount,
    stopMotionCount: () => stopMotionCount,
  };
}

async function testSoftHandoffStartsDistinctRunsForDistinctSegments(): Promise<void> {
  const adapter = installMockAdapter();
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const startedRunIds: string[] = [];
  const firstRunTerminals: Array<{ runId: string; status: string; reason?: string }> = [];
  const plan = buildPlan();

  assert.equal(player.playPlan(plan, null, {
    softHandoff: true,
    onStarted: (_startedPlan, runId) => {
      assert.ok(runId);
      startedRunIds.push(runId);
    },
    onFinished: (event) => {
      firstRunTerminals.push(event);
    },
  }), true);

  assert.equal(player.playPlan(plan, null, {
    softHandoff: true,
    onStarted: (_startedPlan, runId) => {
      assert.ok(runId);
      startedRunIds.push(runId);
    },
  }), true);

  assert.equal(adapter.startCount(), 2);
  assert.equal(startedRunIds.length, 2);
  assert.notEqual(startedRunIds[0], startedRunIds[1]);
  assert.deepEqual(firstRunTerminals, [{
    runId: startedRunIds[0],
    status: "stopped",
    reason: "direct_parameter_plan_replaced",
  }]);
  scope.stop();
}

async function testSoftHandoffExpressionFailureKeepsPreviousRunOwned(): Promise<void> {
  const active = {
    terminal: undefined as ((event: { runId: string; status: "completed" }) => void) | undefined,
    runId: "",
  };
  let stopExpressionCount = 0;
  (globalThis as typeof globalThis & { getLAppAdapter?: () => unknown }).getLAppAdapter = () => ({
    startDirectParameterPlan: (_plan: unknown, options: { runId: string; onTerminal: typeof active.terminal }) => {
      active.runId = options.runId;
      active.terminal = options.onTerminal;
      return true;
    },
    stopDirectParameterPlan: () => {},
    getDirectParameterPlanError: () => "",
    stopExpression: () => {
      stopExpressionCount += 1;
    },
    setExpression: () => false,
    getExpressionStartError: () => "expression_missing",
  });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const terminals: Array<{ status: string; reason?: string }> = [];
  assert.equal(player.playPlan(buildPlan(), null, {
    softHandoff: true,
    onFinished: (event) => terminals.push(event),
  }), true);

  const replacement = buildPlan();
  replacement.resource = {
    kind: "expression",
    resource_id: "expression.missing",
    expression_id: "Missing",
    parameter_ids: ["ParamMouthForm"],
  };
  assert.equal(player.playPlan(replacement, null, { softHandoff: true }), false);
  assert.equal(terminals.length, 0);
  assert.equal(stopExpressionCount, 1);
  active.terminal?.({ runId: active.runId, status: "completed" });
  assert.equal(terminals[0]?.status, "completed");
  scope.stop();
}

async function testSoftHandoffDirectFailureSettlesPreviousRun(): Promise<void> {
  let startCount = 0;
  (globalThis as typeof globalThis & { getLAppAdapter?: () => unknown }).getLAppAdapter = () => ({
    startDirectParameterPlan: () => {
      startCount += 1;
      return startCount === 1;
    },
    stopDirectParameterPlan: () => {},
    getDirectParameterPlanError: () => "replacement_rejected",
    stopExpression: () => {},
  });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const terminals: Array<{ status: string; reason?: string }> = [];
  assert.equal(player.playPlan(buildPlan(), null, {
    softHandoff: true,
    onFinished: (event) => terminals.push(event),
  }), true);
  assert.equal(player.playPlan(buildPlan(), null, { softHandoff: true }), false);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.status, "stopped");
  assert.equal(terminals[0]?.reason, "direct_parameter_plan_replacement_failed");
  scope.stop();
}

async function testExpressionResourceStartsBeforeDirectPlan(): Promise<void> {
  const calls: string[] = [];
  (globalThis as typeof globalThis & { getLAppAdapter?: () => unknown }).getLAppAdapter = () => ({
    setExpression: (expressionId: string) => {
      calls.push(`expression:${expressionId}`);
      return true;
    },
    stopExpression: () => {},
    getExpressionStartError: () => "",
    startDirectParameterPlan: () => {
      calls.push("direct_plan");
      return true;
    },
    stopDirectParameterPlan: () => {},
    getDirectParameterPlanError: () => "",
  });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const plan = buildPlan();
  plan.resource = {
    kind: "expression",
    resource_id: "expression.smile",
    expression_id: "Smile",
    parameter_ids: ["ParamMouthForm"],
  };

  assert.equal(player.playPlan(plan), true);
  assert.deepEqual(calls, ["expression:Smile", "direct_plan"]);
  scope.stop();
}

async function testExpressionResourceFailureDoesNotStartDirectPlan(): Promise<void> {
  let directPlanStarts = 0;
  (globalThis as typeof globalThis & { getLAppAdapter?: () => unknown }).getLAppAdapter = () => ({
    setExpression: () => false,
    stopExpression: () => {},
    getExpressionStartError: () => "expression_not_found",
    startDirectParameterPlan: () => {
      directPlanStarts += 1;
      return true;
    },
    stopDirectParameterPlan: () => {},
    getDirectParameterPlanError: () => "",
  });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const plan = buildPlan();
  plan.resource = {
    kind: "expression",
    resource_id: "expression.missing",
    expression_id: "Missing",
    parameter_ids: ["ParamMouthForm"],
  };

  assert.equal(player.playPlan(plan), false);
  assert.equal(directPlanStarts, 0);
  assert.match(player.state.message, /expression_not_found/);
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

async function testDirectPlanWatchdogStopsSdkPlan(): Promise<void> {
  const adapter = installMockAdapter();
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const plan = buildPlan();
  plan.timing = {
    duration_ms: 320,
    blend_in_ms: 60,
    hold_ms: 180,
    blend_out_ms: 80,
  };

  assert.equal(player.playPlan(plan, null), true);
  const stopCountAfterStart = adapter.stopCount();
  await new Promise((resolve) => setTimeout(resolve, 1150));

  assert.equal(player.state.status, "failed");
  assert.equal(adapter.stopCount(), stopCountAfterStart + 1);
  assert.deepEqual(adapter.stopEvents().at(-1), {
    reason: "direct_parameter_plan_terminal_timeout",
    status: "failed",
  });
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

async function testCatalogMotionWaitsForSdkTerminalCallback(): Promise<void> {
  installCatalogMockAdapter({ status: "async_motion_accepted" });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);

  assert.equal(player.playCatalogMotion(buildCatalogMotion(1), null), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(player.state.status, "playing");
  scope.stop();
}

async function testCatalogMotionStopDelegatesToSdkAndReportsStopped(): Promise<void> {
  const adapter = installCatalogMockAdapter({ status: "async_motion_accepted" });
  const scope = effectScope();
  const player = scope.run(() => usePreviewMotionPlayer());
  assert.ok(player);
  const finished: Array<{ runId: string; status: string; reason?: string }> = [];

  assert.equal(player.playCatalogMotion(buildCatalogMotion(), null, {
    onFinished: (event) => {
      finished.push(event);
    },
  }), true);
  player.stopPlan("manual_stop");

  assert.equal(adapter.stopMotionCount(), 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, "stopped");
  assert.equal(finished[0].reason, "manual_stop");
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
  await testSoftHandoffStartsDistinctRunsForDistinctSegments();
  await testSoftHandoffExpressionFailureKeepsPreviousRunOwned();
  await testSoftHandoffDirectFailureSettlesPreviousRun();
  await testExpressionResourceStartsBeforeDirectPlan();
  await testExpressionResourceFailureDoesNotStartDirectPlan();
  await testCatalogMotionInvalidHandleWithDurationFails();
  await testCatalogMotionInvalidHandleWithoutDurationStillFails();
  await testDirectPlanWatchdogStopsSdkPlan();
  await testCatalogMotionAsyncAcceptedFailureReportsFailed();
  await testCatalogMotionReportsStartedAndCompletedCallbacks();
  await testCatalogMotionWaitsForSdkTerminalCallback();
  await testCatalogMotionStopDelegatesToSdkAndReportsStopped();
  await testDirectPlanStopReportsStoppedTerminalOnce();
  console.log("previewMotionPlayer tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
