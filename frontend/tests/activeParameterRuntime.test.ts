import assert from "node:assert/strict";
import {
  PARAMETER_MIX_PRIORITY,
  ActiveParameterMixer,
  type ParameterBaseSnapshot,
  type ParameterContribution,
} from "../src/live2d/WebSDK/src/parametermixer.js";
import {
  resolveParameterPresentationFrame,
  type ParameterPresentationNode,
} from "../src/live2d/WebSDK/src/parameterpresentation.js";

type WritableParameterBaseSnapshot = Extract<
  ParameterBaseSnapshot,
  { writable: true }
>;

const parameterId = {} as WritableParameterBaseSnapshot["parameterId"];

function testParameterContributionOrderingAndFinalClamp(): void {
  const mixer = new ActiveParameterMixer();
  const contributions: ParameterContribution[] = [
    {
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "lip_sync",
      source: "lip_sync",
      value: 5,
      weight: 1,
      priority: PARAMETER_MIX_PRIORITY.lipSync,
    },
    {
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "direct_plan",
      source: "direct_plan:test_axis",
      value: 6,
      weight: 0.5,
      priority: PARAMETER_MIX_PRIORITY.directPlan,
    },
  ];

  const baseSnapshots: ReadonlyMap<number, ParameterBaseSnapshot> = new Map([
    [0, {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      writable: true,
      baseValue: 2,
      minimumValue: -10,
      maximumValue: 4,
    }],
  ]);
  const result = mixer.resolveFrame(contributions, baseSnapshots);

  if (!result.ok) {
    throw new Error(`Expected a resolved parameter frame: ${result.reason}`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.parameters.length, 1);
  assert.equal(result.parameters[0].owner, "mixed");
  assert.equal(result.parameters[0].unclampedValue, 5);
  assert.equal(result.parameters[0].value, 4);
  assert.equal(result.parameters[0].clamped, true);
  assert.deepEqual(
    result.parameters[0].contributions.map((contribution) => contribution.source),
    ["direct_plan:test_axis", "lip_sync"],
  );
}

function testInvalidWeightIsRejected(): void {
  const mixer = new ActiveParameterMixer();
  const baseSnapshots: ReadonlyMap<number, ParameterBaseSnapshot> = new Map([
    [0, {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      writable: true,
      baseValue: 0,
      minimumValue: -10,
      maximumValue: 10,
    }],
  ]);
  const result = mixer.resolveFrame([
    {
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "direct_plan",
      source: "invalid-source",
      value: 6,
      weight: 1.5,
      priority: PARAMETER_MIX_PRIORITY.directPlan,
    },
  ], baseSnapshots);

  assert.deepEqual(result, {
    ok: false,
    reason: "parameter_mixer_invalid_weight:ParamMouthOpenY:invalid-source",
    owner: "direct_plan",
  });
}

function testHeadAndBodySpringResponsesAreDistinct(): void {
  const timing = {
    durationMs: 2000,
    blendInMs: 0,
    holdMs: 2000,
    blendOutMs: 0,
    curvePreset: "smooth_hold" as const,
    totalMs: 2000,
  };
  const headNode: ParameterPresentationNode = {
    parameterId: "ParamAngleX",
    initialValue: 0,
    neutralValue: 0,
    maxVelocity: 132,
    maxAcceleration: 720,
    response: { kind: "spring", frequency_hz: 2.4, damping_ratio: 0.78 },
    drivenValue: null,
    velocity: 0,
    lastElapsedMs: null,
  };
  const head = simulateSpringResponse(headNode, 25, timing, 1000);
  const body = simulateSpringResponse({
    parameterId: "ParamBodyAngleX",
    initialValue: 0,
    neutralValue: 0,
    maxVelocity: 28,
    maxAcceleration: 320,
    response: { kind: "spring", frequency_hz: 1, damping_ratio: 0.85 },
    drivenValue: null,
    velocity: 0,
    lastElapsedMs: null,
  }, 8, timing, 2000);

  assert.ok(head.maximum > 25 && head.maximum < 25.7);
  assert.ok(body.maximum > 8 && body.maximum < 8.1);
  assert.ok(head.valueAt400Ms / 25 > body.valueAt400Ms / 8);
  assert.ok(Math.abs(head.finalValue - 25) < 0.001);
  assert.ok(Math.abs(body.finalValue - 8) < 0.001);

  const stalledHeadNode: ParameterPresentationNode = {
    ...headNode,
    drivenValue: null,
    velocity: 0,
    lastElapsedMs: null,
  };
  resolveParameterPresentationFrame(stalledHeadNode, 25, 0, timing);
  resolveParameterPresentationFrame(stalledHeadNode, 25, 200, timing);
  const resumedFrame = resolveParameterPresentationFrame(
    stalledHeadNode,
    25,
    700,
    timing,
  );
  assert.ok(resumedFrame.drivenValue >= 24.9 && resumedFrame.drivenValue <= 25.7);
}

function simulateSpringResponse(
  node: ParameterPresentationNode,
  targetValue: number,
  timing: Parameters<typeof resolveParameterPresentationFrame>[3],
  durationMs: number,
): { maximum: number; valueAt400Ms: number; finalValue: number } {
  let maximum = node.initialValue;
  let valueAt400Ms = node.initialValue;
  let finalValue = node.initialValue;
  for (let elapsedMs = 0; elapsedMs <= durationMs; elapsedMs += 1000 / 60) {
    const frame = resolveParameterPresentationFrame(node, targetValue, elapsedMs, timing);
    maximum = Math.max(maximum, frame.drivenValue);
    finalValue = frame.drivenValue;
    if (elapsedMs >= 400 && valueAt400Ms === node.initialValue) {
      valueAt400Ms = frame.drivenValue;
    }
  }
  return { maximum, valueAt400Ms, finalValue };
}

testParameterContributionOrderingAndFinalClamp();
testInvalidWeightIsRejected();
testHeadAndBodySpringResponsesAreDistinct();
console.log("active parameter runtime tests passed");
