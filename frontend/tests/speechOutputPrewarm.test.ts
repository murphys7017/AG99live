import assert from "node:assert/strict";
import { createSpeechOutputRuntime } from "../src/playback-timeline/speechOutputRuntime.js";

let primers = 0;
let mediaDisconnects = 0;
class Node extends EventTarget {
  gain = { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} };
  frequency = { value: 0 };
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}
class Context {
  state = "running";
  sampleRate = 32000;
  currentTime = 0;
  destination = new Node();
  createGain() { return new Node(); }
  createAnalyser() { return new Node(); }
  createOscillator() { return new Node(); }
  createBuffer() { return { getChannelData: () => new Float32Array(11200) }; }
  createBufferSource() {
    const node = new Node();
    node.start = () => {
      primers++;
      queueMicrotask(() => node.dispatchEvent(new Event("ended")));
    };
    return node;
  }
  createMediaElementSource() {
    const node = new Node();
    node.disconnect = () => { mediaDisconnects++; };
    return node;
  }
  async close() { this.state = "closed"; }
}
Object.assign(globalThis, { window: { AudioContext: Context } });
const runtime = createSpeechOutputRuntime();
await Promise.all([runtime.prepare(), runtime.prepare()]);
const session = runtime.attach({} as HTMLAudioElement);
session.start();
await runtime.prepare();
assert.equal(primers, 1, "prepared output must not repeat its cold primer");
assert.equal(mediaDisconnects, 0, "capture prewarming must preserve active audio");
await runtime.dispose();
await assert.rejects(async () => runtime.prepare(), /disposed/);
console.log("Speech output prewarm public boundary passed.");
