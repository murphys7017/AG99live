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
      operation: "add",
      value: 0.5,
      weight: 1,
      priority: PARAMETER_MIX_PRIORITY.lipSync,
    },
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "direct_plan",
      source: "direct_plan:test_axis",
      operation: "replace",
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
  assert.equal(result.parameters[0].unclampedValue, 4.5);
  assert.equal(result.parameters[0].value, 4);
  assert.equal(result.parameters[0].clamped, true);
  assert.deepEqual(
    result.parameters[0].contributions.map((contribution) => contribution.source),
    ["direct-plan", "lip-sync"],
  );
}

function testInvalidOperationIsRejected(): void {
  const mixer = new ParameterMixer();
  const parameterId = {} as ParameterContribution["parameterId"];
  const result = mixer.resolveFrame([
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      owner: "direct_plan",
      source: "invalid-source",
      operation: "unknown" as ParameterContribution["operation"],
      value: 6,
      weight: 1,
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
    reason: "parameter_mixer_invalid_operation:ParamMouthOpenY:invalid-source",
    owners: ["direct_plan"],
  });
}

testParameterContributionOrderingAndFinalClamp();
testInvalidOperationIsRejected();
console.log("active parameter runtime tests passed");
