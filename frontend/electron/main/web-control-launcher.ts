import { shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAstrbotWebControlUrl,
  DEFAULT_ASTRBOT_WEBUI_URL,
  normalizeAstrbotWebUiUrl,
} from "../../src/app/webControlUrl";

export class WebControlLauncher {
  private currentUrl = DEFAULT_ASTRBOT_WEBUI_URL;
  private initialization: Promise<void> | null = null;
  private pendingWrites: Promise<void> = Promise.resolve();
  private readonly configPath: string;

  constructor(
    private readonly userDataPath: string,
    private readonly reportError: (message: string) => void = console.error,
  ) {
    this.configPath = join(userDataPath, "web-control.json");
  }

  initialize(): Promise<void> {
    this.initialization ??= this.loadUrl();
    return this.initialization;
  }

  getUrl(): string {
    return this.currentUrl;
  }

  async setUrl(value: unknown): Promise<string> {
    const normalized = normalizeAstrbotWebUiUrl(value);
    const request = this.pendingWrites.then(async () => {
      await this.initialize();
      const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.userDataPath, { recursive: true });
        await writeFile(
          temporaryPath,
          JSON.stringify({ astrbotWebUiUrl: normalized }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await rename(temporaryPath, this.configPath);
        this.currentUrl = normalized;
        return normalized;
      } catch (error) {
        this.reportError("Failed to save the AstrBot WebUI address.");
        throw new Error("astrbot_webui_url_save_failed", { cause: error });
      } finally {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (!isMissingFile(error)) {
            this.reportError("Failed to remove the temporary WebUI settings file.");
          }
        }
      }
    });
    // A failed write must not prevent the next explicit settings update.
    this.pendingWrites = request.then(() => undefined, () => undefined);
    return request;
  }

  async open(): Promise<boolean> {
    await this.initialize();
    await this.pendingWrites;
    try {
      await shell.openExternal(buildAstrbotWebControlUrl(this.currentUrl));
      return true;
    } catch {
      this.reportError("Failed to open the AstrBot Web control panel.");
      return false;
    }
  }

  private async loadUrl(): Promise<void> {
    try {
      const config: unknown = JSON.parse(await readFile(this.configPath, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("astrbot_webui_url_invalid");
      }
      this.currentUrl = normalizeAstrbotWebUiUrl(
        "astrbotWebUiUrl" in config ? config.astrbotWebUiUrl : undefined,
      );
    } catch (error) {
      if (!isMissingFile(error)) {
        this.reportError("Failed to read the saved AstrBot WebUI address.");
      }
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}
