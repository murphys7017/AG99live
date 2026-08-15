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
import {
  beginLive2DModelLoad,
  cancelCurrentLive2DModelLoad,
  markLive2DModelFailed,
  waitForLive2DModelLoad,
} from "./modelreadiness";

let isInitializingLive2D = false;
let currentInitializationPromise: Promise<void> | null = null;
let boundPointerTarget: HTMLElement | null = null;
let boundPointerMoveHandler: ((event: PointerEvent) => void) | null = null;
let boundPointerDownHandler: ((event: PointerEvent) => void) | null = null;
let setIgnoreMouseEventsBridge: ((ignore: boolean) => void) | null = null;
let lastIgnoreMouseEventsValue: boolean | null = null;
let lastPointerHitTestAt = 0;
const POINTER_HIT_TEST_INTERVAL_MS = 33;

function getPointerModelCoordinates(event: PointerEvent): { x: number; y: number } | null {
  const view = LAppDelegate.getInstance().getView();
  const canvas = document.getElementById("canvas") as HTMLCanvasElement | null;

  if (!view || !canvas || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  const relativeX = event.clientX - rect.left;
  const relativeY = event.clientY - rect.top;

  if (
    relativeX < 0
    || relativeY < 0
    || relativeX > rect.width
    || relativeY > rect.height
  ) {
    return null;
  }

  const scale = canvas.width / canvas.clientWidth;
  const scaledX = relativeX * scale;
  const scaledY = relativeY * scale;

  return {
    x: view._deviceToScreen.transformX(scaledX),
    y: view._deviceToScreen.transformY(scaledY),
  };
}

function applyMouseIgnoreState(ignore: boolean): void {
  if (!setIgnoreMouseEventsBridge) {
    return;
  }

  lastIgnoreMouseEventsValue = ignore;
  setIgnoreMouseEventsBridge(ignore);
}

function updateMouseIgnoreState(ignore: boolean): void {
  if (!setIgnoreMouseEventsBridge) {
    return;
  }

  if ((window as Window & { __ag99PetWindowDragging?: boolean }).__ag99PetWindowDragging) {
    return;
  }

  if (lastIgnoreMouseEventsValue === ignore) {
    return;
  }

  applyMouseIgnoreState(ignore);
}

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
  delete (window as any).__ag99SetPetMouseIgnoreState;
  setIgnoreMouseEventsBridge = null;
  lastIgnoreMouseEventsValue = null;
  lastPointerHitTestAt = 0;
}

/**
 * Initialize the Live2D application
 */
export function initializeLive2D(): Promise<void> {
  if (currentInitializationPromise) {
    return currentInitializationPromise;
  }
  currentInitializationPromise = initializeLive2DOnce().finally(() => {
    currentInitializationPromise = null;
  });
  return currentInitializationPromise;
}

export function cancelLive2DInitialization(
  reason = "live2d_model_load_cancelled",
): boolean {
  return cancelCurrentLive2DModelLoad(reason);
}

export function releaseLive2D(
  reason = "live2d_renderer_released",
): void {
  cancelCurrentLive2DModelLoad(reason);
  cleanupHitTestPointerHandlers();
  LAppDelegate.releaseInstance();
  LAppGlManager.releaseInstance();
  delete (window as any).getLive2DManager;
  delete (window as any).getLAppAdapter;
}

async function initializeLive2DOnce(): Promise<void> {
  isInitializingLive2D = true;

  const finishInitialize = () => {
    isInitializingLive2D = false;
  };

  // Release the previous Cubism instance before assigning the next load
  // generation, so stale model teardown cannot cancel the new generation.
  releaseLive2D("live2d_model_load_replaced");

  const loadGeneration = beginLive2DModelLoad();

  console.log(
    "Initializing Live2D with resourcePath:",
    LAppDefine.ResourcesPath
  );
  console.log("Model directories:", LAppDefine.ModelDir);

  const canvasElement = document.getElementById('canvas');
  if (!canvasElement) {
    const reason = 'live2d_canvas_missing';
    markLive2DModelFailed(loadGeneration, reason);
    finishInitialize();
    throw new Error(reason);
  }

  if (
    !LAppGlManager.getInstance() ||
    !LAppDelegate.getInstance().initialize()
  ) {
    const reason = "live2d_framework_initialization_failed";
    markLive2DModelFailed(loadGeneration, reason);
    finishInitialize();
    throw new Error(reason);
  }

  LAppDelegate.getInstance().run();

  (window as any).getLive2DManager = () => LAppLive2DManager.getInstance();

  // Make sure LAppAdapter is available globally
  if (!(window as any).getLAppAdapter) {
    console.log('Setting up getLAppAdapter function');
    (window as any).getLAppAdapter = () => LAppAdapter.getInstance();
  }

  const setIgnoreMouseEvents = (window as any).ag99desktop?.setIgnoreMouseEvents;
  if (typeof setIgnoreMouseEvents === 'function') {
    setIgnoreMouseEventsBridge = setIgnoreMouseEvents;
    (window as any).__ag99SetPetMouseIgnoreState = applyMouseIgnoreState;
    const parent = document.getElementById("live2d");

    if (parent) {
      boundPointerTarget = parent;
    }

    boundPointerMoveHandler = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastPointerHitTestAt < POINTER_HIT_TEST_INTERVAL_MS) {
        return;
      }
      lastPointerHitTestAt = now;

      const model = LAppLive2DManager.getInstance().getModel(0);
      const coordinates = getPointerModelCoordinates(e);

      if (!coordinates) {
        updateMouseIgnoreState(true);
        return;
      }

      const isHit = model?.anyHitTestWithFallback(coordinates.x, coordinates.y) ?? false;
      updateMouseIgnoreState(!isHit);
    };

    // Add pointerdown event listener
    boundPointerDownHandler = (e: PointerEvent) => {
      const model = LAppLive2DManager.getInstance().getModel(0);
      const coordinates = getPointerModelCoordinates(e);

      if (!coordinates) {
        return;
      }

      // Test hit and log result
      const hitAreaName = model?.anyhitTest(coordinates.x, coordinates.y);
      const isHit = hitAreaName !== null || model?.isHitOnModel(coordinates.x, coordinates.y);
      console.log("Model clicked:", isHit, hitAreaName ? `in area: ${hitAreaName}` : '');
    };

    if (boundPointerTarget && boundPointerMoveHandler) {
      boundPointerTarget.addEventListener("pointermove", boundPointerMoveHandler);
    }
    if (boundPointerTarget && boundPointerDownHandler) {
      boundPointerTarget.addEventListener("pointerdown", boundPointerDownHandler);
    }
  }

  try {
    await waitForLive2DModelLoad(loadGeneration);
  } finally {
    finishInitialize();
  }
}

/**
 * 終了時の処理
 * 结束时的处理
 */
window.addEventListener(
  "beforeunload",
  (): void => {
    releaseLive2D("live2d_window_unloaded");
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
