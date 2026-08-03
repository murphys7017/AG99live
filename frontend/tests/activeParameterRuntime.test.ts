import assert from "node:assert/strict";
import {
  PARAMETER_MIX_PRIORITY,
  ParameterMixer,
  type ParameterContribution,
} from "../src/live2d/WebSDK/src/parametermixer.js";
function testParameterContributionOrderingAndFinalClamp(): void {
  const mixer = new ParameterMixer();
  const parameterId = {} as ParameterContribution["parameterId"];
  const contributions: ParameterContribution[] = [
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "lip_sync",
      source: "lip_sync",
      value: 5,
      weight: 1,
      priority: PARAMETER_MIX_PRIORITY.lipSync,
    },
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "direct_plan",
      source: "direct_plan:test_axis",
      value: 6,
      weight: 0.5,
      priority: PARAMETER_MIX_PRIORITY.directPlan,
    },
  ];

  const result = mixer.resolveFrame(contributions, {
    isParameterIndexWritable: () => true,
    getParameterValue: () => 2,
    getParameterMinimumValue: () => -10,
    getParameterMaximumValue: () => 4,
  });

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
  const parameterId = {} as ParameterContribution["parameterId"];
  const result = mixer.resolveFrame([
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "direct_plan",
      source: "invalid-source",
      value: 6,
      weight: 1.5,
      priority: PARAMETER_MIX_PRIORITY.directPlan,
    },
  ], {
    isParameterIndexWritable: () => true,
    getParameterValue: () => 0,
    getParameterMinimumValue: () => -10,
    getParameterMaximumValue: () => 10,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "parameter_mixer_invalid_weight:ParamMouthOpenY:invalid-source",
    owner: "direct_plan",
  });
}

testParameterContributionOrderingAndFinalClamp();
testInvalidWeightIsRejected();
console.log("active parameter runtime tests passed");
