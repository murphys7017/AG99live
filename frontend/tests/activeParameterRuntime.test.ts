import assert from "node:assert/strict";
import {
  PARAMETER_MIX_PRIORITY,
  ParameterMixer,
  type ParameterBaseSnapshot,
  type ParameterContribution,
} from "../src/live2d/WebSDK/src/parametermixer.js";

type WritableParameterBaseSnapshot = Extract<
  ParameterBaseSnapshot,
  { writable: true }
>;

const parameterId = {} as WritableParameterBaseSnapshot["parameterId"];

function testParameterContributionOrderingAndFinalClamp(): void {
  const mixer = new ParameterMixer();
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
  const mixer = new ParameterMixer();
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

testParameterContributionOrderingAndFinalClamp();
testInvalidWeightIsRejected();
console.log("active parameter runtime tests passed");
