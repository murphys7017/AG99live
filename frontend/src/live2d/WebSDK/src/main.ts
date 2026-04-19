// @ts-nocheck
/* eslint-disable no-underscore-dangle */
/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { LAppDelegate } from "./lappdelegate";
import * as LAppDefine from "./lappdefine";
import { LAppAdapter } from "./lappadapter";
import { LAppGlManager } from "./lappglmanager";
import { LAppLive2DManager } from "./lapplive2dmanager";

let isInitializingLive2D = false;
let pendingInitializeLive2D = false;
let boundPointerTarget: HTMLElement | null = null;
let boundPointerMoveHandler: ((event: PointerEvent) => void) | null = null;
let boundPointerDownHandler: ((event: PointerEvent) => void) | null = null;

function cleanupHitTestPointerHandlers(): void {
  if (boundPointerTarget && boundPointerMoveHandler) {
    boundPointerTarget.removeEventListener("pointermove", boundPointerMoveHandler);
  }
  if (boundPointerTarget && boundPointerDownHandler) {
    boundPointerTarget.removeEventListener("pointerdown", boundPointerDownHandler);
  }

  boundPointerTarget = null;
  boundPointerMoveHandler = null;
  boundPointerDownHandler = null;
}

/**
 * Initialize the Live2D application
 */
export function initializeLive2D(): void {
  if (isInitializingLive2D) {
    pendingInitializeLive2D = true;
    return;
  }
  isInitializingLive2D = true;

  const finishInitialize = () => {
    isInitializingLive2D = false;
    if (pendingInitializeLive2D) {
      pendingInitializeLive2D = false;
      setTimeout(() => initializeLive2D(), 0);
    }
  };

  console.log(
    "Initializing Live2D with resourcePath:",
    LAppDefine.ResourcesPath
  );
  console.log("Model directories:", LAppDefine.ModelDir);

  const canvasElement = document.getElementById('canvas');
  if (!canvasElement) {
    // Canvas may not be mounted yet when model info arrives very early.
    setTimeout(() => {
      const retryCanvas = document.getElementById('canvas');
      if (!retryCanvas) {
        console.error('Live2D initialization skipped: canvas element not found.');
        finishInitialize();
        return;
      }
      initializeLive2D();
      finishInitialize();
    }, 120);
    return;
  }

  // Clean up any existing instances first.
  // Repeated initialize without full delegate release can spawn multiple RAF loops.
  cleanupHitTestPointerHandlers();
  LAppDelegate.releaseInstance();
  LAppLive2DManager.releaseInstance();
  LAppGlManager.releaseInstance();

  if (
    !LAppGlManager.getInstance() ||
    !LAppDelegate.getInstance().initialize()
  ) {
    console.error("Failed to initialize Live2D");
    finishInitialize();
    return;
  }

  LAppDelegate.getInstance().run();

  (window as any).getLive2DManager = () => LAppLive2DManager.getInstance();

  // Make sure LAppAdapter is available globally
  if (!(window as any).getLAppAdapter) {
    console.log('Setting up getLAppAdapter function');
    (window as any).getLAppAdapter = () => LAppAdapter.getInstance();
  }

  const setIgnoreMouseEvents = (window as any).api?.setIgnoreMouseEvents;
  if (typeof setIgnoreMouseEvents === 'function') {
    const parent = document.getElementById("live2d");

    if (parent) {
      boundPointerTarget = parent;
    }

    boundPointerMoveHandler = (e: PointerEvent) => {
      const model = LAppLive2DManager.getInstance().getModel(0);
      const view = LAppDelegate.getInstance().getView();

      // Transform screen coordinates to Live2D canvas coordinates
      const x = view?._deviceToScreen.transformX(e.x);
      const y = view?._deviceToScreen.transformY(e.y);

      // Check if mouse is over the Live2D model
      setIgnoreMouseEvents(!model?.anyhitTest(x, y) && !model?.isHitOnModel(x, y));
    };

    // Add pointerdown event listener
    boundPointerDownHandler = (e: PointerEvent) => {
      const model = LAppLive2DManager.getInstance().getModel(0);
      const view = LAppDelegate.getInstance().getView();

      // Transform screen coordinates to Live2D canvas coordinates
      const x = view?._deviceToScreen.transformX(e.x);
      const y = view?._deviceToScreen.transformY(e.y);

      // Test hit and log result
      const hitAreaName = model?.anyhitTest(x, y);
      const isHit = hitAreaName !== null || model?.isHitOnModel(x, y);
      console.log("Model clicked:", isHit, hitAreaName ? `in area: ${hitAreaName}` : '');
    };

    if (boundPointerTarget && boundPointerMoveHandler) {
      boundPointerTarget.addEventListener("pointermove", boundPointerMoveHandler);
    }
    if (boundPointerTarget && boundPointerDownHandler) {
      boundPointerTarget.addEventListener("pointerdown", boundPointerDownHandler);
    }
  }

  finishInitialize();
}

/**
 * Keep the original window.load handler for backwards compatibility
 * (for the standalone HTML file)
 */
/* // Comment out the window.load listener
window.addEventListener(
  "load",
  (): void => {
    initializeLive2D();
  },
  { passive: true }
);
*/

/**
 * 終了時の処理
 * 结束时的处理
 */
window.addEventListener(
  "beforeunload",
  (): void => {
    cleanupHitTestPointerHandlers();
    LAppDelegate.releaseInstance();
  },
  { passive: true }
);

/**
 * Process when changing screen size.
 */
window.addEventListener(
  "resize",
  () => {
    if (LAppDefine.CanvasSize === "auto") {
      LAppDelegate.getInstance().onResize();
    }
  },
  { passive: true }
);

// Make the initialization function available globally
(window as any).initializeLive2D = initializeLive2D;
