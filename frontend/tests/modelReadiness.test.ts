import assert from "node:assert/strict";
import {
  beginLive2DModelLoad,
  cancelCurrentLive2DModelLoad,
  cancelLive2DModelLoad,
  getLive2DModelLoadState,
  isLive2DModelLoadActive,
  markLive2DModelReady,
  waitForLive2DModelLoad,
} from "../src/live2d/WebSDK/src/modelreadiness.js";

async function testCancelledGenerationCannotCompleteLater(): Promise<void> {
  const generation = beginLive2DModelLoad();
  const pending = waitForLive2DModelLoad(generation);

  assert.equal(isLive2DModelLoadActive(generation), true);
  assert.equal(cancelLive2DModelLoad(generation, "test_load_cancelled"), true);
  await assert.rejects(pending, /test_load_cancelled/);
  assert.equal(getLive2DModelLoadState().status, "idle");

  markLive2DModelReady(generation);
  assert.equal(getLive2DModelLoadState().status, "idle");
}

async function testReplacementGenerationRejectsStaleOwnership(): Promise<void> {
  const firstGeneration = beginLive2DModelLoad();
  const firstPending = waitForLive2DModelLoad(firstGeneration);
  assert.equal(cancelCurrentLive2DModelLoad("test_load_replaced"), true);
  await assert.rejects(firstPending, /test_load_replaced/);

  const secondGeneration = beginLive2DModelLoad();
  assert.notEqual(secondGeneration, firstGeneration);
  assert.equal(isLive2DModelLoadActive(firstGeneration), false);
  assert.equal(isLive2DModelLoadActive(secondGeneration), true);
  assert.equal(cancelLive2DModelLoad(firstGeneration), false);
  assert.equal(cancelLive2DModelLoad(secondGeneration), true);
}

async function run(): Promise<void> {
  await testCancelledGenerationCannotCompleteLater();
  await testReplacementGenerationRejectsStaleOwnership();
  console.log("modelReadiness tests passed");
}

await run();
