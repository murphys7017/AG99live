import assert from "node:assert/strict";
import {
  PARAMETER_MIX_PRIORITY,
  ParameterMixer,
  type ParameterContribution,
} from "../src/live2d/WebSDK/src/parametermixer.js";
import {
  SpeechSignalRuntime,
} from "../src/live2d/WebSDK/src/speechsignalruntime.js";

function testAudioSourceLifecycle(): void {
  const runtime = new SpeechSignalRuntime();

  runtime.beginSource("lip-sync:1");
  runtime.writeSource("lip-sync:1", {
    lipSyncValue: 0.75,
    speechEnergyValue: 1,
  });

  assert.equal(runtime.advanceFrame(1, true).lipSyncValue, 0.75);
  assert.equal(runtime.advanceFrame(1_000, true).lipSyncValue, 0.75);
  assert.throws(
    () => runtime.writeSource("lip-sync:2", { lipSyncValue: 0.5 }),
    /speech_signal_source_mismatch:lip-sync:2:lip-sync:1/,
  );
  assert.throws(
    () => runtime.endSource("lip-sync:2"),
    /speech_signal_source_mismatch:lip-sync:2:lip-sync:1/,
  );

  runtime.endSource("lip-sync:1");
  assert.equal(runtime.advanceFrame(1 / 60, true).lipSyncValue, 0);
  runtime.endSource("lip-sync:1");

  runtime.beginSource("lip-sync:2");
  assert.equal(runtime.advanceFrame(1 / 60, true).lipSyncValue, 0);
  runtime.endSource("lip-sync:2");
}

function testParameterContributionOrderingAndWeight(): void {
  const mixer = new ParameterMixer();
  const parameterId = {} as ParameterContribution["parameterId"];
  const contributions: ParameterContribution[] = [
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      source: "lip-sync",
      operation: "add",
      value: 0.5,
      weight: 1,
      priority: PARAMETER_MIX_PRIORITY.lipSync,
    },
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      source: "direct-plan",
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
    getParameterMaximumValue: () => 10,
  });

  if (!result.ok) {
    throw new Error(`Expected a resolved parameter frame: ${result.reason}`);
  }
  assert.equal(result.ok, true);
  assert.equal(result.parameters.length, 1);
  assert.equal(result.parameters[0].value, 4.5);
  assert.deepEqual(
    result.parameters[0].contributions.map((contribution) => contribution.source),
    ["direct-plan", "lip-sync"],
  );
}

function testInvalidReplaceWeightIsRejected(): void {
  const mixer = new ParameterMixer();
  const parameterId = {} as ParameterContribution["parameterId"];
  const result = mixer.resolveFrame([
    {
      parameterId,
      parameterIdRaw: "ParamMouthOpenY",
      parameterIndex: 0,
      source: "direct-plan",
      operation: "replace",
      value: 6,
      weight: 1.1,
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
    reason: "parameter_mixer_invalid_replace_weight:ParamMouthOpenY:direct-plan",
  });
}

testAudioSourceLifecycle();
testParameterContributionOrderingAndWeight();
testInvalidReplaceWeightIsRejected();
console.log("active parameter runtime tests passed");
