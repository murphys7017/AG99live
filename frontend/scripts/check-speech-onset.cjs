// Run with npm run check:speech-onset [-- path/to/phrase.wav].
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function runInElectron(work) {
  const { app, BrowserWindow } = require("electron");
  app.commandLine.appendSwitch("mute-audio");
  app.setPath("userData", path.join(work, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  try {
    await win.loadFile(path.join(work, "index.html"));
    const report = await win.webContents.executeJavaScript("speechOnset.run()");
    fs.writeFileSync(path.join(work, "result.json"), JSON.stringify(report, null, 2));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(work, "result.json"), String(error.stack ?? error));
    app.exit(1);
  }
}

async function run() {
  const { spawnSync } = require("node:child_process");
  const { build } = await import("vite");
  const tempRoot = fs.realpathSync(os.tmpdir());
  const work = fs.mkdtempSync(path.join(tempRoot, "ag99-speech-onset-"));
  try {
    await build({
      configFile: false, publicDir: false, logLevel: "warn",
      build: { outDir: work, emptyOutDir: false, lib: {
        entry: path.join(__dirname, "speech-onset-probe.ts"), name: "speechOnset",
        formats: ["iife"], fileName: () => "probe.js",
      } },
    });
    const wav = process.argv[2] ? fs.readFileSync(process.argv[2]).toString("base64") : null;
    fs.writeFileSync(path.join(work, "index.html"),
      '<meta charset="utf-8"><script>window.fixtureWav=' + JSON.stringify(wav) + '</script><script src="probe.js"></script>');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require("electron"), [__filename, work], { env, timeout: 65000, windowsHide: true });
    const result = path.join(work, "result.json");
    if (fs.existsSync(result)) console.log(fs.readFileSync(result, "utf8"));
    if (child.error) throw child.error;
    if (child.status !== 0) throw Error("Speech onset check failed: " + (child.stderr ?? ""));
  } finally {
    if (path.dirname(work) === tempRoot && path.basename(work).startsWith("ag99-speech-onset-")) {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

if (process.versions.electron) {
  runInElectron(process.argv[2]).catch(error => {
    fs.writeFileSync(path.join(process.argv[2], "result.json"), String(error));
    require("electron").app.exit(1);
  });
} else {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
