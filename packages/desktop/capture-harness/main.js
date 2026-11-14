const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  app,
  BrowserWindow,
  dialog: electronDialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
} = require("electron");

const ROOT = __dirname;
const OUT_DIR = process.env.PASEO_CAPTURE_HARNESS_OUT_DIR || path.join(ROOT, "out");
// The compiled desktop main process the harness exercises; another build (for example the committed
// revision, to show a check failing before a change) can be pointed at with this variable.
const DIST_DIR = process.env.PASEO_CAPTURE_HARNESS_DIST_DIR || path.join(ROOT, "..", "dist");
const PRODUCTION_BROWSER_AUTOMATION_DIR = path.join(DIST_DIR, "features", "browser-automation");
const { captureFullPage } = require(
  path.join(PRODUCTION_BROWSER_AUTOMATION_DIR, "full-page-capture.js"),
);
const PRODUCTION_BROWSER_AUTOMATION_SERVICE_PATH = path.join(
  PRODUCTION_BROWSER_AUTOMATION_DIR,
  "service.js",
);
const PRODUCTION_BROWSER_AUTOMATION_IPC_PATH = path.join(
  PRODUCTION_BROWSER_AUTOMATION_DIR,
  "ipc.js",
);
const PRODUCTION_BROWSER_SNAPSHOT_ENGINE_PATH = path.join(
  PRODUCTION_BROWSER_AUTOMATION_DIR,
  "snapshot-engine.js",
);
const PRODUCTION_BROWSER_KEYBOARD_DIR = path.join(DIST_DIR, "features", "browser-keyboard");
const PRODUCTION_BROWSER_GUEST_PRELOAD_PATH = path.join(
  PRODUCTION_BROWSER_KEYBOARD_DIR,
  "guest-preload.js",
);
const PRODUCTION_BROWSER_KEYBOARD_PATH = path.join(PRODUCTION_BROWSER_KEYBOARD_DIR, "index.js");
const PRODUCTION_BROWSER_WEBVIEW_REGISTRY_PATH = path.join(
  DIST_DIR,
  "features",
  "browser-webviews",
  "registry.js",
);
const BROWSER_SHORTCUT_INPUT_CHANNEL = "paseo:browser-shortcut-input";
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const FULL_PAGE_HEIGHT = 1600;
const CAPTURE_TIMEOUT_MS = 5000;
const BROWSER_PROFILE_TIMEOUT_MS = 15000;
const CAPTURE_RETRY_INTERVAL_MS = 200;
const REPEAT_COUNT = 5;
const FRESH_REPEAT_COUNT = 3;
const SOAK_MS = Number(process.env.PASEO_CAPTURE_HARNESS_SOAK_MS || 75000);
const HARNESS_GROUP = process.env.PASEO_CAPTURE_HARNESS_GROUP || "permanent-parking";
const BROWSER_PROFILE_PHASE = process.env.PASEO_CAPTURE_HARNESS_PHASE || "";
const BROWSER_PROFILE_ORIGIN_FILE = path.join(OUT_DIR, "browser-profile-origin.txt");
const BROWSER_PROFILE_VALUE_FILE = path.join(OUT_DIR, "browser-profile-value.txt");
const PERMANENT_STATE_FILTER = new Set(
  (process.env.PASEO_CAPTURE_HARNESS_STATES || "P1")
    .split(",")
    .map((state) => state.trim())
    .filter(Boolean),
);
const PERMANENT_VARIANT_FILTER = new Set(
  (process.env.PASEO_CAPTURE_HARNESS_VARIANTS || "attach-off")
    .split(",")
    .map((variant) => variant.trim())
    .filter(Boolean),
);
const PERMANENT_CAPTURE_MODES = ["viewport", "full-page"];
const PERMANENT_THROTTLING_VARIANTS = [
  {
    id: "capture-only-throttling",
    code: "capture-only",
    label: "backgroundThrottling disabled only during each capture",
    disableGuestBackgroundThrottlingAtAttach: false,
  },
  {
    id: "attach-off-throttling",
    code: "attach-off",
    label: "backgroundThrottling disabled once at guest attach",
    disableGuestBackgroundThrottlingAtAttach: true,
  },
];
const ATTACH_OFF_VARIANT_STATE_CODES = new Set(["P1", "P3", "P7"]);
const PERMANENT_PARKING_STATES = [
  {
    id: "p1-overflow-1x1",
    code: "P1",
    label: "host 1x1 overflow hidden",
  },
  {
    id: "p2-clip-path-1x1",
    code: "P2",
    label: "host 1x1 clip-path inset 1px",
  },
  {
    id: "p3-opacity-0",
    code: "P3",
    label: "host full-size opacity 0",
  },
  {
    id: "p4-transform-scale-0",
    code: "P4a",
    label: "host full-size transform scale(0)",
  },
  {
    id: "p4-transform-scale-0001",
    code: "P4b",
    label: "host full-size transform scale(0.001)",
  },
  {
    id: "p5-webview-0x0",
    code: "P5a",
    label: "webview element 0x0",
  },
  {
    id: "p5-webview-1x1",
    code: "P5b",
    label: "webview element 1x1",
  },
  {
    id: "p6-z-index-negative",
    code: "P6",
    label: "host full-size z-index -1 behind page",
  },
  {
    id: "p7-opacity-001",
    code: "P7",
    label: "host full-size opacity 0.01",
  },
];

function applyEarlyMacHarnessActivationPolicy() {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    app.setActivationPolicy("accessory");
  } catch {
    // App readiness varies by Electron/macOS version; enforce again before windows.
  }
}

function applyMacHarnessActivationPolicyBeforeWindows() {
  if (process.platform !== "darwin") {
    return;
  }
  app.setActivationPolicy("accessory");
  app.dock?.hide();
}

applyEarlyMacHarnessActivationPolicy();

function fileUrl(filePath, params = {}) {
  const url = new URL(`file://${filePath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function startBrowserProfileServer() {
  let port = 0;
  if (BROWSER_PROFILE_PHASE === "read") {
    const previousOrigin = (await fsp.readFile(BROWSER_PROFILE_ORIGIN_FILE, "utf8")).trim();
    port = Number(new URL(previousOrigin).port);
  }

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Shared browser profile</title><h1>Profile fixture</h1>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("browser profile fixture server has no TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  if (BROWSER_PROFILE_PHASE === "write") {
    await fsp.writeFile(BROWSER_PROFILE_ORIGIN_FILE, `${origin}\n`);
  }
  return { origin, server };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cornerWindowBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const inset = 12;
  return {
    x: Math.round(workArea.x + workArea.width - width - inset),
    y: Math.round(workArea.y + workArea.height - height - inset),
    width,
    height,
  };
}

function createInactiveHarnessWindow(input) {
  const { width, height, ...options } = input;
  const win = new BrowserWindow({
    ...options,
    ...cornerWindowBounds(width, height),
    show: false,
    skipTaskbar: true,
  });
  const readyToShow = new Promise((resolve) => {
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.showInactive();
      }
      resolve();
    });
  });
  return { win, readyToShow };
}

async function waitForInactiveReveal(handle, label) {
  await withTimeout(handle.readyToShow, `${label} ready-to-show`);
  await delay(250);
}

function withTimeout(promise, label, timeoutMs = CAPTURE_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4;
}

function isBrightMagenta(bitmap, offset) {
  const c0 = bitmap[offset];
  const c1 = bitmap[offset + 1];
  const c2 = bitmap[offset + 2];
  return c0 > 200 && c1 < 90 && c2 > 200;
}

function hasBottomMarker(bitmap, width, height, devicePixelRatio) {
  const crop = {
    left: Math.min(width, Math.round(40 * devicePixelRatio)),
    top: Math.min(height, Math.round(1320 * devicePixelRatio)),
    right: Math.min(width, Math.round(1150 * devicePixelRatio)),
    bottom: Math.min(height, Math.round(1500 * devicePixelRatio)),
  };
  let pixels = 0;
  let nonBright = 0;
  for (let y = crop.top; y < crop.bottom; y += 1) {
    for (let x = crop.left; x < crop.right; x += 1) {
      pixels += 1;
      if (!isBrightMagenta(bitmap, pixelOffset(width, x, y))) {
        nonBright += 1;
      }
    }
  }
  return pixels > 0 && nonBright / pixels > 0.01;
}

function analyzeImage(image, expected, guestMetrics) {
  if (!image || image.isEmpty()) {
    return {
      width: 0,
      height: 0,
      logicalWidthAtDpr: 0,
      logicalHeightAtDpr: 0,
      brightRatio: 0,
      textNonUniform: false,
      bottomMarkerVisible: false,
      matchedSize: false,
      pass: false,
    };
  }

  const size = image.getSize();
  const width = size.width;
  const height = size.height;
  const bitmap = image.toBitmap();
  const totalPixels = width * height;
  let brightPixels = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (isBrightMagenta(bitmap, offset)) {
      brightPixels += 1;
    }
  }

  const crop = {
    left: Math.min(40, Math.max(0, width - 1)),
    top: Math.min(40, Math.max(0, height - 1)),
    right: Math.min(width, 940),
    bottom: Math.min(height, 260),
  };
  let cropPixels = 0;
  let cropNonBright = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  const quantized = new Set();
  for (let y = crop.top; y < crop.bottom; y += 1) {
    for (let x = crop.left; x < crop.right; x += 1) {
      const offset = pixelOffset(width, x, y);
      cropPixels += 1;
      if (!isBrightMagenta(bitmap, offset)) {
        cropNonBright += 1;
      }
      const r = bitmap[offset + 2];
      const g = bitmap[offset + 1];
      const b = bitmap[offset];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luminanceSum += luma;
      luminanceSqSum += luma * luma;
      quantized.add(`${r >> 5},${g >> 5},${b >> 5},${bitmap[offset + 3] >> 6}`);
    }
  }

  const devicePixelRatio =
    typeof guestMetrics.devicePixelRatio === "number" && guestMetrics.devicePixelRatio > 0
      ? guestMetrics.devicePixelRatio
      : 1;
  const sizeTargets = [
    { width: expected.width, height: expected.height },
    {
      width: Math.round(expected.width * devicePixelRatio),
      height: Math.round(expected.height * devicePixelRatio),
    },
  ];
  const matchedSize = sizeTargets.some(
    (target) => Math.abs(width - target.width) <= 2 && Math.abs(height - target.height) <= 2,
  );
  const luminanceMean = cropPixels ? luminanceSum / cropPixels : 0;
  const luminanceVariance = cropPixels
    ? luminanceSqSum / cropPixels - luminanceMean * luminanceMean
    : 0;
  const brightRatio = totalPixels ? brightPixels / totalPixels : 0;
  const textNonUniform =
    cropPixels > 0 &&
    cropNonBright / cropPixels > 0.02 &&
    quantized.size >= 4 &&
    luminanceVariance > 100;
  const bottomMarkerVisible = hasBottomMarker(bitmap, width, height, devicePixelRatio);
  const requiredPixelsVisible = !expected.requiresBottomMarker || bottomMarkerVisible;

  return {
    width,
    height,
    logicalWidthAtDpr: width / devicePixelRatio,
    logicalHeightAtDpr: height / devicePixelRatio,
    brightRatio,
    textNonUniform,
    bottomMarkerVisible,
    matchedSize,
    pass:
      matchedSize &&
      brightRatio >= expected.minBrightRatio &&
      textNonUniform &&
      requiredPixelsVisible,
  };
}

function expectedForMode(mode) {
  return mode === "viewport"
    ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
    : {
        width: VIEWPORT_WIDTH,
        height: FULL_PAGE_HEIGHT,
        minBrightRatio: 0.55,
        requiresBottomMarker: true,
      };
}

function summarizeAnalysis(analysis) {
  if (!analysis) {
    return {
      width: 0,
      height: 0,
      logicalWidthAtDpr: 0,
      logicalHeightAtDpr: 0,
      brightRatio: 0,
      textNonUniform: false,
      bottomMarkerVisible: false,
      matchedSize: false,
      pass: false,
    };
  }
  return {
    width: analysis.width,
    height: analysis.height,
    logicalWidthAtDpr: analysis.logicalWidthAtDpr,
    logicalHeightAtDpr: analysis.logicalHeightAtDpr,
    brightRatio: analysis.brightRatio,
    textNonUniform: analysis.textNonUniform,
    bottomMarkerVisible: analysis.bottomMarkerVisible,
    matchedSize: analysis.matchedSize,
    pass: analysis.pass,
  };
}

function analysisSize(analysis) {
  if (!analysis) {
    return "0x0";
  }
  return `${analysis.width}x${analysis.height}`;
}

function analysisLogicalSize(analysis) {
  if (!analysis) {
    return "0x0";
  }
  return `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.log(`FAIL ${message}`);
  throw new Error(message);
}

async function saveImage(image, outputPath) {
  ensureDirSync(path.dirname(outputPath));
  await fsp.writeFile(outputPath, image.toPNG());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGuestLoad(contents, input = {}) {
  await new Promise((resolve) => {
    if (!contents.isLoading()) {
      resolve();
      return;
    }
    contents.once("did-finish-load", resolve);
    contents.once("did-fail-load", resolve);
  });
  const settleMs = input.settleMs ?? 500;
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

async function renderer(win, expression) {
  return await win.webContents.executeJavaScript(expression, true);
}

async function readGuestMetrics(contents) {
  return await contents.executeJavaScript(
    `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      visualViewport: window.visualViewport ? {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        scale: window.visualViewport.scale
      } : null
    })`,
    true,
  );
}

async function capturePageSequence(contents) {
  contents.invalidate();
  return await withTimeout(contents.capturePage(undefined, { stayHidden: false }), "capturePage");
}

async function captureFullPageSequence(contents) {
  let attachedHere = false;
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach("1.3");
    attachedHere = true;
  }
  try {
    return await captureFullPage({
      executeJavaScript: (script) =>
        withTimeout(contents.executeJavaScript(script, true), "full-page guest script"),
      sendDebugCommand: (method, params) =>
        withTimeout(contents.debugger.sendCommand(method, params), `full-page ${method}`),
      invalidate: () => contents.invalidate(),
      createImageFromPng: (dataBase64) =>
        nativeImage.createFromBuffer(Buffer.from(dataBase64, "base64")),
      createImageFromBitmap: (bitmap, size) =>
        nativeImage.createFromBitmap(Buffer.from(bitmap), { ...size, scaleFactor: 1 }),
    });
  } finally {
    if (attachedHere && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
  }
}

function installHarnessWebviewGuards(win, options = {}) {
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (options.preloadPath) {
      webPreferences.nodeIntegrationInSubFrames = true;
      webPreferences.nodeIntegrationInWorker = false;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.webviewTag = false;
      webPreferences.allowRunningInsecureContent = false;
      delete webPreferences.preload;
      delete params.preload;
      delete webPreferences.preloadURL;
      delete params.preloadURL;
      webPreferences.preload = options.preloadPath;
    }
  });
}

function trackAttachedGuests(win, input = {}) {
  const attachedGuests = [];
  const waiters = [];
  const countWaiters = [];
  win.webContents.on("did-attach-webview", (_event, contents) => {
    if (input.disableGuestBackgroundThrottlingAtAttach) {
      contents.setBackgroundThrottling(false);
    }
    attachedGuests.push(contents);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(contents);
    }
    for (let index = countWaiters.length - 1; index >= 0; index -= 1) {
      const countWaiter = countWaiters[index];
      if (attachedGuests.length >= countWaiter.count) {
        countWaiters.splice(index, 1);
        countWaiter.resolve(attachedGuests.slice(0, countWaiter.count));
      }
    }
  });
  return {
    attachedGuests,
    waitForNextAttachedGuest() {
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    waitForAttachedGuests(count) {
      if (attachedGuests.length >= count) {
        return Promise.resolve(attachedGuests.slice(0, count));
      }
      return new Promise((resolve) => {
        countWaiters.push({ count, resolve });
      });
    },
  };
}

async function createPermanentHarnessWindow(state, variant) {
  const handle = createInactiveHarnessWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, {
    disableGuestBackgroundThrottlingAtAttach: variant.disableGuestBackgroundThrottlingAtAttach,
  });
  await withTimeout(
    win.loadFile(path.join(ROOT, "index.html"), {
      query: {
        webviewCount: "0",
        permanentParkingState: state.id,
        targetUrl: fileUrl(path.join(ROOT, "bright.html")),
      },
    }),
    "permanent harness window loadFile",
  );
  await waitForInactiveReveal(handle, "permanent harness window");
  return { win, tracker };
}

async function createPermanentKeeperWindow() {
  const handle = createInactiveHarnessWindow({
    width: 1,
    height: 1,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  await withTimeout(win.loadURL("about:blank"), "permanent keeper loadURL");
  await waitForInactiveReveal(handle, "permanent keeper");
  return win;
}

async function closeHarnessWindow(win) {
  if (!win.isDestroyed()) {
    win.close();
  }
}

function targetUrlForVariant(state, variant, phase, mode, index) {
  const webviewNumber = index + 1;
  return fileUrl(path.join(ROOT, "bright.html"), {
    label: `${state.code} ${variant.code} ${phase.toUpperCase()} W${webviewNumber}`,
    sub: `${mode.toUpperCase()} ${state.id} ${variant.code}`,
    bottom: `${state.code} ${variant.code} FULL PAGE MARKER`,
  });
}

function variantsForPermanentState(state) {
  const defaultVariants = ATTACH_OFF_VARIANT_STATE_CODES.has(state.code)
    ? PERMANENT_THROTTLING_VARIANTS
    : [PERMANENT_THROTTLING_VARIANTS[0]];
  if (PERMANENT_VARIANT_FILTER.size === 0) {
    return defaultVariants;
  }
  return defaultVariants.filter(
    (variant) =>
      PERMANENT_VARIANT_FILTER.has(variant.id) || PERMANENT_VARIANT_FILTER.has(variant.code),
  );
}

async function appendPermanentWebview({ win, tracker, state, sourceUrl }) {
  const guestPromise = tracker.waitForNextAttachedGuest();
  const targetIndex = await withTimeout(
    renderer(
      win,
      `window.captureHarness.addPermanentWebview(${JSON.stringify(sourceUrl)}, ${JSON.stringify(state.id)})`,
    ),
    "permanent add webview",
  );
  const guest = await withTimeout(guestPromise, "permanent did-attach-webview");
  return { guest, targetIndex };
}

async function measurePermanentCapture({
  contents,
  mode,
  state,
  variant,
  phase,
  repeatIndex,
  repeatTotal,
  targetIndex,
  guestMetrics,
  retryUntilPass = false,
}) {
  const outputPath = path.join(
    OUT_DIR,
    "permanent-parking",
    variant.id,
    state.id,
    `${phase}-${mode}-webview-${targetIndex + 1}-${repeatIndex}.png`,
  );
  await fsp.rm(outputPath, { force: true });
  const expected = expectedForMode(mode);
  const start = Date.now();
  const deadline = start + CAPTURE_TIMEOUT_MS;
  let attempt = 0;
  let lastAnalysis = null;
  let lastError = "";
  let lastImage = null;

  while (Date.now() < deadline || attempt === 0) {
    attempt += 1;
    try {
      const image =
        mode === "viewport"
          ? await capturePageSequence(contents)
          : await captureFullPageSequence(contents);
      lastImage = image;
      lastAnalysis = analyzeImage(image, expected, guestMetrics);
      if (lastAnalysis.pass) {
        await saveImage(image, outputPath);
        const latencyMs = Date.now() - start;
        const result = {
          group: "permanent-parking",
          stateId: state.id,
          stateCode: state.code,
          stateLabel: state.label,
          variantId: variant.id,
          variantCode: variant.code,
          variantLabel: variant.label,
          attachTimeBackgroundThrottlingDisabled: variant.disableGuestBackgroundThrottlingAtAttach,
          phase,
          mode,
          repeatIndex,
          repeatTotal,
          targetIndex,
          attempts: attempt,
          latencyMs,
          outputPath,
          error: null,
          analysis: summarizeAnalysis(lastAnalysis),
          pass: true,
        };
        pass(
          `permanent ${state.code} ${variant.code} ${phase} ${mode} webview ${targetIndex + 1} ${repeatIndex}/${repeatTotal} attempts=${attempt} size=${analysisSize(lastAnalysis)} logical=${analysisLogicalSize(lastAnalysis)} bright=${lastAnalysis.brightRatio.toFixed(4)} text=${lastAnalysis.textNonUniform} bottom=${lastAnalysis.bottomMarkerVisible} file=${outputPath}`,
        );
        return result;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (!retryUntilPass) {
      break;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(CAPTURE_RETRY_INTERVAL_MS, remainingMs));
  }

  if (lastImage && !lastImage.isEmpty()) {
    await saveImage(lastImage, outputPath);
  }
  const latencyMs = Date.now() - start;
  const bright = lastAnalysis ? lastAnalysis.brightRatio.toFixed(4) : "0.0000";
  const textNonUniform = lastAnalysis ? lastAnalysis.textNonUniform : false;
  const size = analysisSize(lastAnalysis);
  const logicalSize = analysisLogicalSize(lastAnalysis);
  const result = {
    group: "permanent-parking",
    stateId: state.id,
    stateCode: state.code,
    stateLabel: state.label,
    variantId: variant.id,
    variantCode: variant.code,
    variantLabel: variant.label,
    attachTimeBackgroundThrottlingDisabled: variant.disableGuestBackgroundThrottlingAtAttach,
    phase,
    mode,
    repeatIndex,
    repeatTotal,
    targetIndex,
    attempts: attempt,
    latencyMs,
    outputPath: lastImage && !lastImage.isEmpty() ? outputPath : null,
    error: lastError || null,
    analysis: summarizeAnalysis(lastAnalysis),
    pass: false,
  };
  console.log(
    `FAIL permanent ${state.code} ${variant.code} ${phase} ${mode} webview ${targetIndex + 1} ${repeatIndex}/${repeatTotal} attempts=${attempt} size=${size} logical=${logicalSize} bright=${bright} text=${textNonUniform} error=${lastError || "pixel verdict failed"} file=${result.outputPath || "none"}`,
  );
  return result;
}

async function writePermanentParkingResults(results) {
  await fsp.writeFile(
    path.join(OUT_DIR, "permanent-parking-results.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        soakMs: SOAK_MS,
        states: PERMANENT_PARKING_STATES,
        variants: PERMANENT_THROTTLING_VARIANTS,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

async function captureWithPrep({
  win,
  contents,
  mode,
  repeatIndex,
  targetIndex,
  guestMetrics,
  repeatTotal = REPEAT_COUNT,
  label = "prep",
  retryUntilPass = false,
}) {
  const preparation = await renderer(
    win,
    `window.captureHarness.prepareForPixelCapture(${JSON.stringify(targetIndex)})`,
  );
  const outputPath = path.join(
    OUT_DIR,
    `${mode}-webview-${targetIndex + 1}-${label}-${repeatIndex}.png`,
  );
  try {
    const expected =
      mode === "viewport"
        ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
        : { width: VIEWPORT_WIDTH, height: FULL_PAGE_HEIGHT, minBrightRatio: 0.55 };
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    let attempt = 0;
    let lastFailure = "capture did not run";
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        const image =
          mode === "viewport"
            ? await capturePageSequence(contents)
            : await captureFullPageSequence(contents);
        const analysis = analyzeImage(image, expected, guestMetrics);
        const size = `${analysis.width}x${analysis.height}`;
        const logicalSize = `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
        const bright = analysis.brightRatio.toFixed(4);
        if (analysis.pass) {
          await saveImage(image, outputPath);
          pass(
            `${mode} webview ${targetIndex + 1} ${label} ${repeatIndex}/${repeatTotal} attempts=${attempt} size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
          );
          return analysis;
        }
        lastFailure = `size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} bottom=${analysis.bottomMarkerVisible}`;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (!retryUntilPass) {
        break;
      }
      await delay(Math.min(CAPTURE_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    fail(
      `${mode} webview ${targetIndex + 1} ${label} ${repeatIndex}/${repeatTotal} failed attempts=${attempt} last=${lastFailure} file=${outputPath}`,
    );
  } finally {
    const restoredState = await renderer(
      win,
      `window.captureHarness.restorePixelCapture(${JSON.stringify(preparation.token)})`,
    );
    const style = restoredState.hostStyle;
    if (style.left !== "-20000px" || style.opacity !== "0") {
      fail(`restore left=${style.left} opacity=${style.opacity}`);
    }
  }
}

async function expectLegacySecondWebviewFailure({ win, contents, mode, guestMetrics }) {
  const targetIndex = 1;
  const preparation = await renderer(
    win,
    `window.captureHarness.prepareLegacyVerticalPixelCapture(${JSON.stringify(targetIndex)})`,
  );
  const outputPath = path.join(OUT_DIR, `${mode}-legacy-webview-${targetIndex + 1}.png`);
  try {
    const image =
      mode === "viewport"
        ? await capturePageSequence(contents)
        : await captureFullPageSequence(contents);
    await saveImage(image, outputPath);
    const expected =
      mode === "viewport"
        ? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 }
        : { width: VIEWPORT_WIDTH, height: FULL_PAGE_HEIGHT, minBrightRatio: 0.55 };
    const analysis = analyzeImage(image, expected, guestMetrics);
    const size = `${analysis.width}x${analysis.height}`;
    const logicalSize = `${analysis.logicalWidthAtDpr}x${analysis.logicalHeightAtDpr}`;
    const bright = analysis.brightRatio.toFixed(4);
    if (analysis.pass) {
      fail(
        `${mode} legacy webview ${targetIndex + 1} unexpectedly captured size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
      );
    }
    pass(
      `${mode} legacy webview ${targetIndex + 1} reproduces no-frame size=${size} logical=${logicalSize} bright=${bright} text=${analysis.textNonUniform} file=${outputPath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pass(`${mode} legacy webview ${targetIndex + 1} reproduces no-frame error=${message}`);
  } finally {
    await renderer(
      win,
      `window.captureHarness.restoreLegacyVerticalParking(${JSON.stringify(preparation.token)})`,
    );
  }
}

async function captureFreshDelayedWebview({ win, waitForNextAttachedGuest, mode }) {
  const freshGuestPromise = waitForNextAttachedGuest();
  const targetIndex = await renderer(
    win,
    `window.captureHarness.addWebview(${JSON.stringify(fileUrl(path.join(ROOT, "delayed-bright.html")))})`,
  );
  const guest = await withTimeout(freshGuestPromise, "fresh did-attach-webview");
  const guestMetrics = await readGuestMetrics(guest);
  if (guestMetrics.innerWidth !== VIEWPORT_WIDTH || guestMetrics.innerHeight !== VIEWPORT_HEIGHT) {
    fail(
      `fresh guest viewport sizing webview ${targetIndex + 1} inner=${guestMetrics.innerWidth}x${guestMetrics.innerHeight} expected=${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
    );
  }
  pass(
    `fresh guest viewport sizing webview ${targetIndex + 1} inner=${guestMetrics.innerWidth}x${guestMetrics.innerHeight} dpr=${guestMetrics.devicePixelRatio}`,
  );
  await captureWithPrep({
    win,
    contents: guest,
    mode,
    repeatIndex: 1,
    targetIndex,
    guestMetrics,
    repeatTotal: 1,
    label: "fresh-delayed-first-frame",
    retryUntilPass: true,
  });
}

async function runPermanentFreshPhase(state, variant, results) {
  for (let repeatIndex = 1; repeatIndex <= FRESH_REPEAT_COUNT; repeatIndex += 1) {
    for (const mode of PERMANENT_CAPTURE_MODES) {
      const { win, tracker } = await createPermanentHarnessWindow(state, variant);
      try {
        const sourceUrl = targetUrlForVariant(state, variant, "fresh", mode, 0);
        const { guest, targetIndex } = await appendPermanentWebview({
          win,
          tracker,
          state,
          sourceUrl,
        });
        const guestMetrics = await readGuestMetrics(guest);
        results.push(
          await measurePermanentCapture({
            contents: guest,
            mode,
            state,
            variant,
            phase: "fresh",
            repeatIndex,
            repeatTotal: FRESH_REPEAT_COUNT,
            targetIndex,
            guestMetrics,
            retryUntilPass: true,
          }),
        );
      } finally {
        await closeHarnessWindow(win);
      }
    }
  }
}

async function runPermanentSettledAndSoakPhases(state, variant, results) {
  const { win, tracker } = await createPermanentHarnessWindow(state, variant);
  try {
    const targets = [];
    for (const mode of PERMANENT_CAPTURE_MODES) {
      const sourceUrl = targetUrlForVariant(state, variant, "settled", mode, targets.length);
      const target = await appendPermanentWebview({ win, tracker, state, sourceUrl });
      targets.push({ mode, ...target });
    }
    await Promise.all(targets.map((target) => waitForGuestLoad(target.guest)));
    await delay(250);
    const guestMetrics = new Map();
    for (const target of targets) {
      guestMetrics.set(target.targetIndex, await readGuestMetrics(target.guest));
    }

    for (const target of targets) {
      for (let repeatIndex = 1; repeatIndex <= REPEAT_COUNT; repeatIndex += 1) {
        results.push(
          await measurePermanentCapture({
            contents: target.guest,
            mode: target.mode,
            state,
            variant,
            phase: "settled",
            repeatIndex,
            repeatTotal: REPEAT_COUNT,
            targetIndex: target.targetIndex,
            guestMetrics: guestMetrics.get(target.targetIndex),
          }),
        );
      }
    }

    console.log(`SOAK permanent ${state.code} idle ${SOAK_MS}ms`);
    await delay(SOAK_MS);

    for (let repeatIndex = 1; repeatIndex <= REPEAT_COUNT; repeatIndex += 1) {
      for (const target of targets) {
        results.push(
          await measurePermanentCapture({
            contents: target.guest,
            mode: target.mode,
            state,
            variant,
            phase: "soak",
            repeatIndex,
            repeatTotal: REPEAT_COUNT,
            targetIndex: target.targetIndex,
            guestMetrics: guestMetrics.get(target.targetIndex),
          }),
        );
      }
    }
  } finally {
    await closeHarnessWindow(win);
  }
}

async function runPermanentMultiTabPhase(state, variant, results) {
  const { win, tracker } = await createPermanentHarnessWindow(state, variant);
  try {
    const targets = [];
    for (let index = 0; index < 3; index += 1) {
      const sourceUrl = targetUrlForVariant(state, variant, "multi", "multi", index);
      const target = await appendPermanentWebview({ win, tracker, state, sourceUrl });
      targets.push(target);
    }
    await Promise.all(targets.map((target) => waitForGuestLoad(target.guest)));
    await delay(250);
    const guestMetrics = new Map();
    for (const target of targets) {
      guestMetrics.set(target.targetIndex, await readGuestMetrics(target.guest));
    }

    for (const target of targets.slice(1, 3)) {
      for (const mode of PERMANENT_CAPTURE_MODES) {
        results.push(
          await measurePermanentCapture({
            contents: target.guest,
            mode,
            state,
            variant,
            phase: "multi-tab",
            repeatIndex: 1,
            repeatTotal: 1,
            targetIndex: target.targetIndex,
            guestMetrics: guestMetrics.get(target.targetIndex),
          }),
        );
      }
    }
  } finally {
    await closeHarnessWindow(win);
  }
}

async function createOccludingWindow(targetWindow) {
  const bounds = targetWindow.getBounds();
  const handle = createInactiveHarnessWindow({
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop: true,
    backgroundColor: "#101010",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win: blocker } = handle;
  await blocker.loadURL(
    "data:text/html;charset=utf-8,<html><body style='margin:0;background:#101010'></body></html>",
  );
  await waitForInactiveReveal(handle, "occluding window");
  blocker.setAlwaysOnTop(true);
  await delay(500);
  return blocker;
}

async function runPermanentWindowHostilityPhase(state, variant, results) {
  const { win, tracker } = await createPermanentHarnessWindow(state, variant);
  let blocker = null;
  try {
    const targets = [];
    for (const mode of PERMANENT_CAPTURE_MODES) {
      const sourceUrl = targetUrlForVariant(state, variant, "hostile", mode, targets.length);
      const target = await appendPermanentWebview({ win, tracker, state, sourceUrl });
      targets.push({ mode, ...target });
    }
    await Promise.all(targets.map((target) => waitForGuestLoad(target.guest)));
    await delay(250);
    const guestMetrics = new Map();
    for (const target of targets) {
      guestMetrics.set(target.targetIndex, await readGuestMetrics(target.guest));
    }

    blocker = await createOccludingWindow(win);
    for (const target of targets) {
      results.push(
        await measurePermanentCapture({
          contents: target.guest,
          mode: target.mode,
          state,
          variant,
          phase: "window-occluded",
          repeatIndex: 1,
          repeatTotal: 1,
          targetIndex: target.targetIndex,
          guestMetrics: guestMetrics.get(target.targetIndex),
        }),
      );
    }
    await closeHarnessWindow(blocker);
    blocker = null;

    win.minimize();
    await delay(800);
    for (const target of targets) {
      results.push(
        await measurePermanentCapture({
          contents: target.guest,
          mode: target.mode,
          state,
          variant,
          phase: "window-minimized",
          repeatIndex: 1,
          repeatTotal: 1,
          targetIndex: target.targetIndex,
          guestMetrics: guestMetrics.get(target.targetIndex),
        }),
      );
    }
  } finally {
    if (blocker) {
      await closeHarnessWindow(blocker);
    }
    await closeHarnessWindow(win);
  }
}

async function runPermanentParkingState(state, variant, results) {
  console.log(`STATE permanent ${state.code} ${variant.code} ${state.label}`);
  await runPermanentFreshPhase(state, variant, results);
  await writePermanentParkingResults(results);
  await runPermanentSettledAndSoakPhases(state, variant, results);
  await writePermanentParkingResults(results);
  await runPermanentMultiTabPhase(state, variant, results);
  await writePermanentParkingResults(results);
  await runPermanentWindowHostilityPhase(state, variant, results);
  await writePermanentParkingResults(results);
}

async function runPermanentParkingGroup() {
  const results = [];
  await fsp.rm(path.join(OUT_DIR, "permanent-parking"), { recursive: true, force: true });
  await fsp.rm(path.join(OUT_DIR, "permanent-parking-results.json"), { force: true });
  const keeper = await createPermanentKeeperWindow();
  const states =
    PERMANENT_STATE_FILTER.size === 0
      ? PERMANENT_PARKING_STATES
      : PERMANENT_PARKING_STATES.filter(
          (state) => PERMANENT_STATE_FILTER.has(state.id) || PERMANENT_STATE_FILTER.has(state.code),
        );
  console.log(`RUN permanent-parking states=${states.length} soakMs=${SOAK_MS}`);
  try {
    for (const state of states) {
      for (const variant of variantsForPermanentState(state)) {
        try {
          await runPermanentParkingState(state, variant, results);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`FAIL permanent ${state.code} ${variant.code} fatal error=${message}`);
          results.push({
            group: "permanent-parking",
            stateId: state.id,
            stateCode: state.code,
            stateLabel: state.label,
            variantId: variant.id,
            variantCode: variant.code,
            variantLabel: variant.label,
            attachTimeBackgroundThrottlingDisabled:
              variant.disableGuestBackgroundThrottlingAtAttach,
            phase: "fatal",
            mode: "setup",
            repeatIndex: 1,
            repeatTotal: 1,
            targetIndex: 0,
            attempts: 0,
            latencyMs: 0,
            outputPath: null,
            error: message,
            analysis: summarizeAnalysis(null),
            pass: false,
          });
          await writePermanentParkingResults(results);
        }
      }
    }
  } finally {
    await closeHarnessWindow(keeper);
  }
  const failedResults = results.filter((result) => !result.pass);
  if (failedResults.length > 0) {
    fail(`permanent parking failed ${failedResults.length}/${results.length} checks`);
  }
  return results;
}

function automationFixtureUrl() {
  const html = `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Automation Fixture</title></head>
      <style>
        body { min-height: 1800px; }
        #hover-target { display: none; }
        #hover-source:hover + #hover-target { display: inline-block; }
        #moving {
          animation: slide 320ms linear;
        }
        #drag-target {
          display: inline-block;
          margin-left: 24px;
          padding: 12px;
          border: 1px solid #888;
        }
        @keyframes slide {
          from { transform: translateX(80px); }
          to { transform: translateX(0); }
        }
      </style>
      <body>
        <main>
          <h1>Settings</h1>
          <section aria-label="Account">
            <p>Connected as Maya</p>
            <label for="name">Name</label>
            <input id="name" value="Maya">
            <a href="#docs">Read docs</a>
            <button id="save">Save changes</button>
            <button id="delayed" disabled>Delayed save</button>
            <button id="moving">Moving target</button>
            <button id="hover-source">Reveal actions</button>
            <button id="hover-target">Revealed action</button>
            <button id="drag-source">Drag source</button>
            <span id="drag-target" role="button" tabindex="0">Drop target</span>
            <button id="dialog-alert">Open alert</button>
            <button id="dialog-confirm">Open confirm</button>
            <button id="dialog-prompt">Open prompt</button>
            <button id="dialog-beforeunload">Arm beforeunload</button>
            <input id="upload" type="file" aria-label="Upload receipt">
          </section>
        </main>
        <script>
          window.fixtureLog = [];
          window.preventBrowserShortcut = false;
          window.installLateBrowserShortcutHandler = () => {
            window.addEventListener(
              "keydown",
              (event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  !event.altKey &&
                  !event.shiftKey &&
                  event.key.toLowerCase() === "b"
                ) {
                  event.preventDefault();
                  window.fixtureLog.push({
                    event: "late-shortcut-b",
                    defaultPrevented: event.defaultPrevented,
                    trusted: event.isTrusted,
                  });
                }
              },
              { once: true },
            );
          };
          window.addEventListener("keydown", (event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              !event.shiftKey &&
              event.key.toLowerCase() === "b"
            ) {
              if (window.preventBrowserShortcut) {
                event.preventDefault();
              }
              window.fixtureLog.push({
                event: "shortcut-b",
                defaultPrevented: event.defaultPrevented,
                trusted: event.isTrusted,
              });
            }
          });
          document.getElementById("save").addEventListener("click", (event) => {
            window.fixtureLog.push({
              event: "click-save",
              trusted: event.isTrusted,
              button: event.button,
              detail: event.detail,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
            });
          });
          document.getElementById("save").addEventListener("mousedown", (event) => {
            window.fixtureLog.push({
              event: "down-save",
              trusted: event.isTrusted,
              button: event.button,
              detail: event.detail,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
            });
          });
          document.getElementById("name").addEventListener("input", (event) => {
            window.fixtureLog.push({ event: "input-name", trusted: event.isTrusted });
          });
          document.getElementById("name").addEventListener("keydown", (event) => {
            window.fixtureLog.push({ event: "keydown-name", key: event.key, trusted: event.isTrusted });
          });
          document.getElementById("delayed").addEventListener("click", (event) => {
            window.fixtureLog.push({ event: "click-delayed", trusted: event.isTrusted });
          });
          document.getElementById("moving").addEventListener("click", (event) => {
            window.fixtureLog.push({ event: "click-moving", trusted: event.isTrusted });
          });
          document.getElementById("drag-source").addEventListener("pointerdown", (event) => {
            window.fixtureLog.push({ event: "drag-down", trusted: event.isTrusted });
          });
          document.getElementById("drag-target").addEventListener("pointerup", (event) => {
            window.fixtureLog.push({ event: "drag-up", trusted: event.isTrusted });
          });
          document.getElementById("dialog-alert").addEventListener("click", () => {
            alert("Alert opened");
            window.fixtureLog.push({ event: "alert-returned" });
          });
          document.getElementById("dialog-confirm").addEventListener("click", () => {
            window.fixtureLog.push({ event: "confirm-result", value: confirm("Confirm action?") });
          });
          document.getElementById("dialog-prompt").addEventListener("click", () => {
            window.fixtureLog.push({ event: "prompt-result", value: prompt("Prompt value?", "Maya") });
          });
          window.beforeUnloadEnabled = false;
          document.getElementById("dialog-beforeunload").addEventListener("click", () => {
            window.beforeUnloadEnabled = true;
            window.fixtureLog.push({ event: "beforeunload-armed" });
          });
          window.addEventListener("beforeunload", (event) => {
            if (!window.beforeUnloadEnabled) return;
            event.preventDefault();
            event.returnValue = "Leave fixture?";
          });
          setTimeout(() => {
            document.getElementById("delayed").disabled = false;
          }, 250);
          window.pushFixtureState = () => history.pushState({}, "", "#advanced");
          window.sameUrlRerender = () => {
            const oldSave = document.getElementById("save");
            const nextSave = document.createElement("button");
            nextSave.id = "save";
            nextSave.textContent = "Save later";
            oldSave.replaceWith(nextSave);
          };
        </script>
      </body>
    </html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const AUTOMATION_SNAPSHOT_PROBE = String.raw`(() => {
  const refs = new Map();
  const lines = ['- document "Automation Fixture"'];
  let nextRef = 1;
  function text(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function fingerprint(element, role, name) {
    return { role, name, tagName: element.tagName.toLowerCase(), type: element.getAttribute('type') || '', ariaLabel: element.getAttribute('aria-label') || '' };
  }
  function runtime() {
    const api = {
      refs,
      resolve(ref, expected) {
        const element = refs.get(ref);
        if (!element || !element.isConnected) return { ok: false, reason: 'stale_ref' };
        const role = roleFor(element);
        const name = nameFor(element, role);
        const current = fingerprint(element, role, name);
        return current.role === expected.role && current.name === expected.name && current.tagName === expected.tagName && current.type === expected.type && current.ariaLabel === expected.ariaLabel
          ? { ok: true, element }
          : { ok: false, reason: 'stale_ref' };
      }
    };
    Object.defineProperty(window, '__PASEO_BROWSER_AUTOMATION__', { configurable: true, value: api });
    return api;
  }
  function roleFor(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') return element.type === 'file' ? 'button' : 'textbox';
    if (tag === 'button') return 'button';
    if (element.id === 'drag-target') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'section') return 'region';
    return '';
  }
  function nameFor(element, role) {
    if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
    if (element.id) {
      const label = document.querySelector('label[for="' + element.id + '"]');
      if (label) return text(label.textContent);
    }
    return role === 'textbox' ? text(element.value || element.placeholder) : text(element.textContent);
  }
  const api = runtime();
  const heading = document.querySelector('h1');
  lines.push('  - heading "' + nameFor(heading, 'heading') + '" [level=1]');
  lines.push('  - text: "Connected as Maya"');
  for (const element of document.querySelectorAll('input, a, button, #drag-target')) {
    const role = roleFor(element);
    const name = nameFor(element, role);
    const ref = '@e' + nextRef++;
    const fp = fingerprint(element, role, name);
    api.refs.set(ref, element);
    lines.push('  - ' + role + ' "' + name + '" [ref=' + ref + ']');
  }
  return {
    snapshot: lines.join('\n'),
    refs: Array.from(api.refs.entries()).map(([ref, element]) => {
      const role = roleFor(element);
      return { ref, fingerprint: fingerprint(element, role, nameFor(element, role)) };
    })
  };
})()`;

async function attachAutomationDebugger(guest) {
  if (!guest.debugger.isAttached()) {
    guest.debugger.attach("1.3");
  }
  return (command, params = {}) => guest.debugger.sendCommand(command, params);
}

async function automationRefPoint(guest, ref, fingerprint) {
  const result = await guest.executeJavaScript(
    String.raw`(async () => {
      const fingerprint = ${JSON.stringify(fingerprint)};
      const ref = ${JSON.stringify(ref)};
      const deadline = performance.now() + 5000;
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sameRect = (a, b) =>
        Math.abs(a.x - b.x) < 0.25 &&
        Math.abs(a.y - b.y) < 0.25 &&
        Math.abs(a.width - b.width) < 0.25 &&
        Math.abs(a.height - b.height) < 0.25;
      const isDisabled = (element) =>
        Boolean(element.closest?.('[aria-disabled="true"]')) ||
        Boolean('disabled' in element && element.disabled);
      const isVisible = (element, rect) => {
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      while (performance.now() <= deadline) {
        const resolved = window.__PASEO_BROWSER_AUTOMATION__.resolve(ref, fingerprint);
        if (!resolved.ok || !resolved.element?.isConnected) return { ok: false, reason: 'stale_ref' };
        const element = resolved.element;
        const rect = element.getBoundingClientRect();
        if (!isVisible(element, rect) || isDisabled(element)) {
          await sleep(25);
          continue;
        }
        element.scrollIntoView?.({ block: 'center', inline: 'center' });
        await nextFrame();
        const first = element.getBoundingClientRect();
        await nextFrame();
        const second = element.getBoundingClientRect();
        if (!sameRect(first, second)) continue;
        const x = Math.min(Math.max(second.left + second.width / 2, 0), Math.max(window.innerWidth - 1, 0));
        const y = Math.min(Math.max(second.top + second.height / 2, 0), Math.max(window.innerHeight - 1, 0));
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return { ok: true, x, y };
        await sleep(25);
      }
      return { ok: false, reason: 'timeout' };
    })()`,
    true,
  );
  if (!result || result.ok !== true) {
    fail(`automation ref ${ref} was not actionable: ${JSON.stringify(result)}`);
  }
  return { x: result.x, y: result.y };
}

async function automationClick(guest, refEntry, options = {}) {
  const send = await attachAutomationDebugger(guest);
  const point = await automationRefPoint(guest, refEntry.ref, refEntry.fingerprint);
  const button = options.button || "left";
  const modifiers = automationModifierMask(options.modifiers || []);
  const clickCount = options.doubleClick ? 2 : 1;
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    modifiers,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons: automationButtonMask(button),
    clickCount,
    modifiers,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
  });
  return point;
}

async function automationHover(guest, refEntry) {
  const send = await attachAutomationDebugger(guest);
  const point = await automationRefPoint(guest, refEntry.ref, refEntry.fingerprint);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
}

async function automationScroll(guest, deltaX, deltaY) {
  const send = await attachAutomationDebugger(guest);
  const point = await guest.executeJavaScript(
    "({ x: Math.max(0, (window.innerWidth || 1) / 2), y: Math.max(0, (window.innerHeight || 1) / 2) })",
    true,
  );
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
}

async function automationDrag(guest, sourceRef, targetRef) {
  const send = await attachAutomationDebugger(guest);
  const source = await automationRefPoint(guest, sourceRef.ref, sourceRef.fingerprint);
  const target = await automationRefPoint(guest, targetRef.ref, targetRef.fingerprint);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: source.x,
    y: source.y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: source.x,
    y: source.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function automationType(guest, refEntry, text) {
  const send = await attachAutomationDebugger(guest);
  await automationClick(guest, refEntry);
  await send("Input.insertText", { text });
}

function sendContainedEnter(guest) {
  guest.sendInputEvent({
    type: "keyDown",
    keyCode: "Enter",
    // Prevent Electron from redispatching an unhandled guest key to the embedder.
    skipIfUnhandled: true,
  });
  guest.sendInputEvent({
    type: "keyUp",
    keyCode: "Enter",
    skipIfUnhandled: true,
  });
}

function automationBrowserShortcut(guest, keyCode = "B", options = {}) {
  const modifiers = [process.platform === "darwin" ? "meta" : "control"];
  if (options.shift) {
    modifiers.push("shift");
  }
  guest.sendInputEvent({
    type: "keyDown",
    keyCode,
    modifiers,
  });
  guest.sendInputEvent({
    type: "keyUp",
    keyCode,
    modifiers,
  });
}

async function automationEvaluate(guest, functionSource, refEntry) {
  return guest.executeJavaScript(
    String.raw`(async () => {
      const userFunction = (0, eval)(${JSON.stringify(`(${functionSource})`)});
      const args = [];
      ${
        refEntry
          ? `const resolved = window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(refEntry.ref)}, ${JSON.stringify(refEntry.fingerprint)});
      if (!resolved.ok) return { ok: false, reason: "stale_ref" };
      args.push(resolved.element);`
          : ""
      }
      return JSON.stringify(await userFunction(...args));
    })()`,
    true,
  );
}

const AUTOMATION_DIALOG_POLICY = {
  alert: { action: "accepted", accept: true },
  confirm: { action: "dismissed", accept: false },
  prompt: { action: "dismissed", accept: false },
  beforeunload: { action: "dismissed", accept: false },
};

const AUTOMATION_PROMPT_SHIM_INSTALL = String.raw`(() => {
  const stateKey = "__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__";
  const state = window[stateKey] || { prompts: [], installed: false };
  window[stateKey] = state;
  if (state.installed) return true;
  window.prompt = (message = "", defaultValue = "") => {
    state.prompts.push({
      type: "prompt",
      message: String(message ?? ""),
      defaultValue: String(defaultValue ?? ""),
      action: "dismissed",
      timestamp: Date.now(),
    });
    return null;
  };
  state.installed = true;
  return true;
})()`;

const AUTOMATION_PROMPT_SHIM_DRAIN = String.raw`(() => {
  const state = window.__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__;
  if (!state || !Array.isArray(state.prompts)) return [];
  return state.prompts.splice(0);
})()`;

async function captureAutomationDialogs(guest, action, expectedCount) {
  const send = await attachAutomationDebugger(guest);
  await send("Page.enable");
  await send("Runtime.evaluate", {
    expression: AUTOMATION_PROMPT_SHIM_INSTALL,
    returnByValue: true,
  });
  const dialogs = [];
  const listener = (_event, method, params = {}) => {
    if (method !== "Page.javascriptDialogOpening") return;
    const type = AUTOMATION_DIALOG_POLICY[params.type] ? params.type : "alert";
    const policy = AUTOMATION_DIALOG_POLICY[type];
    dialogs.push({
      type,
      message: String(params.message || ""),
      ...(typeof params.defaultPrompt === "string" ? { defaultValue: params.defaultPrompt } : {}),
      action: policy.action,
      timestamp: Date.now(),
    });
    void send("Page.handleJavaScriptDialog", { accept: policy.accept });
  };
  guest.debugger.on("message", listener);
  try {
    await action();
    const promptResult = await send("Runtime.evaluate", {
      expression: AUTOMATION_PROMPT_SHIM_DRAIN,
      returnByValue: true,
    });
    if (Array.isArray(promptResult.result?.value)) {
      dialogs.push(...promptResult.result.value);
    }
    await waitForDialogCount(dialogs, expectedCount);
    return dialogs;
  } finally {
    guest.debugger.removeListener?.("message", listener);
  }
}

async function waitForDialogCount(dialogs, expectedCount) {
  const deadline = Date.now() + 1000;
  do {
    if (dialogs.length >= expectedCount) return;
    await delay(25);
  } while (Date.now() < deadline);
  fail(`automation observed ${dialogs.length}/${expectedCount} dialogs`);
}

function assertAutomationDialog(dialogs, expected) {
  const dialog = dialogs.find((entry) => entry.type === expected.type);
  if (!dialog) {
    fail(`automation did not report ${expected.type} dialog: ${JSON.stringify(dialogs)}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (dialog[key] !== value) {
      fail(`automation ${expected.type} dialog ${key}=${JSON.stringify(dialog[key])}`);
    }
  }
}

function automationButtonMask(button) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}

function automationModifierMask(modifiers) {
  const masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  return modifiers.reduce((mask, modifier) => mask | masks[modifier], 0);
}

function automationRefByName(snapshot, name) {
  const entry = snapshot.refs.find((ref) => ref.fingerprint.name === name);
  if (!entry) {
    fail(`automation ref missing for ${name}`);
  }
  return entry;
}

async function automationLog(guest) {
  return guest.executeJavaScript("window.fixtureLog", true);
}

async function waitForAutomationLog(guest, predicate, label) {
  const deadline = Date.now() + 1000;
  do {
    const log = await automationLog(guest);
    if (Array.isArray(log) && log.some(predicate)) {
      return log;
    }
    await delay(25);
  } while (Date.now() < deadline);
  fail(`automation log never observed ${label}`);
}

async function waitForBrowserShortcutInput(inputs, expectedCount) {
  const deadline = Date.now() + 1000;
  do {
    if (inputs.length >= expectedCount) {
      return;
    }
    await delay(25);
  } while (Date.now() < deadline);
  fail(`browser shortcut input count stayed at ${inputs.length}; expected ${expectedCount}`);
}

function installBrowserKeyboardSentinels() {
  const previousApplicationMenu = Menu.getApplicationMenu();
  const state = {
    applicationMenuShortcutHits: 0,
    guestId: null,
    shortcutInputs: [],
  };
  const onShortcutInput = (event, input) => {
    if (event.sender.id === state.guestId) {
      state.shortcutInputs.push(input);
    }
  };
  ipcMain.on(BROWSER_SHORTCUT_INPUT_CHANNEL, onShortcutInput);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Capture harness",
        submenu: [
          {
            label: "Browser shortcut sentinel",
            accelerator: "CmdOrCtrl+B",
            click: () => {
              state.applicationMenuShortcutHits += 1;
            },
          },
        ],
      },
    ]),
  );
  return {
    state,
    restore() {
      ipcMain.removeListener(BROWSER_SHORTCUT_INPUT_CHANNEL, onShortcutInput);
      Menu.setApplicationMenu(previousApplicationMenu);
    },
  };
}

async function verifyLatePageShortcutFirstRefusal({ guest, sentinel, shortcutInputs }) {
  await guest.executeJavaScript(
    "window.preventBrowserShortcut = false; window.installLateBrowserShortcutHandler();",
    true,
  );
  automationBrowserShortcut(guest);
  await waitForAutomationLog(
    guest,
    (entry) =>
      entry.event === "late-shortcut-b" &&
      entry.defaultPrevented === true &&
      entry.trusted === true,
    "late page-prevented trusted browser shortcut",
  );
  await delay(100);
  if (shortcutInputs.length !== 0 || sentinel.applicationMenuShortcutHits !== 0) {
    fail(
      `late page-prevented browser shortcut escaped guest: inputs=${JSON.stringify(shortcutInputs)} menu=${sentinel.applicationMenuShortcutHits}`,
    );
  }
  pass("automation late page handlers get first refusal for browser shortcuts");
  return { group: "automation", check: "browser-shortcut-late-page-handler", pass: true };
}

async function verifyFocusedIframeShortcut({ guest, shortcutInputs, expectedInput }) {
  const iframeFocused = await guest.executeJavaScript(
    `new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.srcdoc = '<!doctype html><button id="iframe-target">Frame target</button>';
      iframe.addEventListener("load", () => {
        iframe.contentDocument.getElementById("iframe-target").focus();
        resolve(iframe.contentDocument.activeElement.id);
      }, { once: true });
      document.body.appendChild(iframe);
    })`,
    true,
  );
  if (iframeFocused !== "iframe-target") {
    fail(`automation iframe browser shortcut target was not focused: ${iframeFocused}`);
  }
  automationBrowserShortcut(guest);
  await waitForBrowserShortcutInput(shortcutInputs, 4);
  if (!isDeepStrictEqual(shortcutInputs[3], expectedInput)) {
    fail(
      `iframe browser shortcut crossed boundary incorrectly: inputs=${JSON.stringify(shortcutInputs)}`,
    );
  }
  pass("automation production guest preload forwards shortcuts from focused iframes");
  return { group: "automation", check: "browser-shortcut-focused-iframe", pass: true };
}

async function verifyEditableShortcutExclusion({ guest, shortcutInputs }) {
  await guest.executeJavaScript(
    `window.editableExcludedShortcut = null;
     window.addEventListener("keydown", (event) => {
       if (event.code === "ArrowLeft" && event.shiftKey) {
         window.editableExcludedShortcut = { defaultPrevented: event.defaultPrevented };
       }
     }, { once: true });`,
    true,
  );
  automationBrowserShortcut(guest, "Left", { shift: true });
  await delay(100);
  const observedEvent = await guest.executeJavaScript("window.editableExcludedShortcut", true);
  if (
    shortcutInputs.length !== 2 ||
    !isDeepStrictEqual(observedEvent, { defaultPrevented: false })
  ) {
    fail(
      `editable-only exclusion escaped guest: inputs=${JSON.stringify(shortcutInputs)} event=${JSON.stringify(observedEvent)}`,
    );
  }
  pass("automation editable-only shortcuts keep browser field ownership");
  return { group: "automation", check: "browser-shortcut-editable-exclusion", pass: true };
}

function assertBackgroundHostInput({
  label,
  response,
  hostState,
  expectedValue,
  pageEffect = true,
  details = {},
}) {
  const expectedHostState = {
    activeElementId: "host-composer",
    value: expectedValue,
    blurEvents: 0,
    inputEvents: 0,
  };
  if (!response.ok || !pageEffect || !isDeepStrictEqual(hostState, expectedHostState)) {
    fail(
      `${label}: ${JSON.stringify({ response, hostState, expectedHostState, pageEffect, ...details })}`,
    );
  }
}

async function verifyBackgroundAutomationInputIsolation({ guest, win, browserId }) {
  const { executeAutomationCommand } = require(PRODUCTION_BROWSER_AUTOMATION_SERVICE_PATH);
  const { adaptWebContents } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const { BrowserSnapshotEngine } = require(PRODUCTION_BROWSER_SNAPSHOT_ENGINE_PATH);
  const workspaceId = "capture-harness-workspace";
  const tab = adaptWebContents(guest);
  const registry = {
    listRegisteredBrowserIds: () => [browserId],
    listRegisteredBrowserIdsForWorkspace: (candidateWorkspaceId) =>
      candidateWorkspaceId === workspaceId ? [browserId] : [],
    getTabContents: (candidateBrowserId) => (candidateBrowserId === browserId ? tab : null),
    getBrowserWorkspaceId: (candidateBrowserId) =>
      candidateBrowserId === browserId ? workspaceId : null,
    getWorkspaceActiveBrowserId: () => null,
    isBrowserInputFocused: () => false,
    getBrowserTargetMetadata: () => ({ kind: "tab" }),
  };
  const snapshotEngine = new BrowserSnapshotEngine();
  const execute = (requestId, command) =>
    executeAutomationCommand(
      {
        type: "browser.automation.execute.request",
        requestId,
        workspaceId,
        command,
      },
      registry,
      { snapshotEngine },
    );
  const snapshot = await execute("focus-snapshot", {
    command: "snapshot",
    args: { browserId },
  });
  if (!snapshot.ok) {
    fail(`background focus snapshot failed: ${JSON.stringify(snapshot)}`);
  }
  const nameRef = snapshot.result.snapshot.match(/textbox "Name" \[ref=(@e\d+)\]/)?.[1];
  const saveRef = snapshot.result.snapshot.match(/button "Save changes" \[ref=(@e\d+)\]/)?.[1];
  const dragSourceRef = snapshot.result.snapshot.match(/button "Drag source" \[ref=(@e\d+)\]/)?.[1];
  const dragTargetRef = snapshot.result.snapshot.match(/button "Drop target" \[ref=(@e\d+)\]/)?.[1];
  if (!nameRef || !saveRef || !dragSourceRef || !dragTargetRef) {
    fail(`background focus refs missing: ${snapshot.result.snapshot}`);
  }

  await win.webContents.executeJavaScript(
    `(() => {
      const input = document.getElementById('host-composer');
      window.__focusIsolationProbe = { blurEvents: 0, inputEvents: 0 };
      input.addEventListener('blur', () => { window.__focusIsolationProbe.blurEvents += 1; });
      input.addEventListener('input', () => { window.__focusIsolationProbe.inputEvents += 1; });
    })()`,
    true,
  );
  const focusHost = async (value) => {
    await guest.executeJavaScript("document.getElementById('name').focus()", true);
    await win.webContents.executeJavaScript(
      `(() => {
        const input = document.getElementById('host-composer');
        input.value = ${JSON.stringify(value)};
        window.__focusIsolationProbe.blurEvents = 0;
        window.__focusIsolationProbe.inputEvents = 0;
        input.focus();
      })()`,
      true,
    );
  };
  const readHost = () =>
    win.webContents.executeJavaScript(
      `(() => ({
        activeElementId: document.activeElement?.id || null,
        value: document.getElementById('host-composer').value,
        ...window.__focusIsolationProbe,
      }))()`,
      true,
    );

  await focusHost("human click draft");
  const click = await execute("focus-click", {
    command: "click",
    args: { browserId, ref: saveRef },
  });
  const clickHost = await readHost();
  const clickLog = await automationLog(guest);
  const isolatedClickReachedPage = clickLog.some(
    (entry) => entry.event === "click-save" && entry.trusted === false,
  );
  assertBackgroundHostInput({
    label: "background browser click interrupted host input",
    response: click,
    hostState: clickHost,
    expectedValue: "human click draft",
    pageEffect: isolatedClickReachedPage,
  });

  await focusHost("human drag draft");
  const drag = await execute("focus-drag", {
    command: "drag",
    args: { browserId, sourceRef: dragSourceRef, targetRef: dragTargetRef },
  });
  const dragHost = await readHost();
  const dragLog = await automationLog(guest);
  const isolatedDragReachedPage =
    dragLog.some((entry) => entry.event === "drag-down" && entry.trusted === false) &&
    dragLog.some((entry) => entry.event === "drag-up" && entry.trusted === false);
  assertBackgroundHostInput({
    label: "background browser drag interrupted host input",
    response: drag,
    hostState: dragHost,
    expectedValue: "human drag draft",
    pageEffect: isolatedDragReachedPage,
  });

  await guest.executeJavaScript("document.getElementById('name').value = ''", true);
  await focusHost("human type draft");
  const type = await execute("focus-type", {
    command: "type",
    args: { browserId, ref: nameRef, text: "agent browser text" },
  });
  const typeHost = await readHost();
  const typedGuestValue = await guest.executeJavaScript(
    "document.getElementById('name').value",
    true,
  );
  assertBackgroundHostInput({
    label: "background browser type crossed input ownership",
    response: type,
    hostState: typeHost,
    expectedValue: "human type draft",
    pageEffect: typedGuestValue === "agent browser text",
    details: { typedGuestValue },
  });

  const savePoint = await guest.executeJavaScript(
    `(() => {
      const rect = document.getElementById('save').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    true,
  );
  await focusHost("human remote tap draft");
  const remoteTap = await execute("focus-stream-tap", {
    command: "stream_input",
    args: { browserId, input: { kind: "tap", x: savePoint.x, y: savePoint.y } },
  });
  const remoteTapHost = await readHost();
  const remoteTapTarget = await guest.executeJavaScript("document.activeElement?.id", true);
  assertBackgroundHostInput({
    label: "background remote browser tap interrupted host input",
    response: remoteTap,
    hostState: remoteTapHost,
    expectedValue: "human remote tap draft",
    pageEffect: remoteTapTarget === "save",
    details: { remoteTapTarget },
  });

  await focusHost("human remote text draft");
  const remoteText = await execute("focus-stream-text", {
    command: "stream_input",
    args: { browserId, input: { kind: "text", text: " remote" } },
  });
  const remoteTextHost = await readHost();
  const remoteGuestValue = await guest.executeJavaScript(
    "document.getElementById('name').value",
    true,
  );
  assertBackgroundHostInput({
    label: "background remote browser text crossed input ownership",
    response: remoteText,
    hostState: remoteTextHost,
    expectedValue: "human remote text draft",
    pageEffect: remoteGuestValue === "agent browser text remote",
    details: { remoteGuestValue },
  });

  pass("background browser click, drag, type, remote tap, and remote text preserve host input");
  return { group: "automation", check: "background-input-focus-isolation", pass: true };
}

async function verifyBrowserKeyboardIsolation({ guest, win, browserId, usesMeta, sentinel }) {
  const checks = [];
  const { shortcutInputs } = sentinel;
  await win.webContents.executeJavaScript(
    "window.captureHarness.resetHostBrowserShortcutState()",
    true,
  );
  const pagePreventedTarget = await guest.executeJavaScript(
    "window.preventBrowserShortcut = true; document.getElementById('save').focus(); document.activeElement.id",
    true,
  );
  if (pagePreventedTarget !== "save") {
    fail(`automation browser shortcut target was not focused: ${pagePreventedTarget}`);
  }
  automationBrowserShortcut(guest);
  await waitForAutomationLog(
    guest,
    (entry) =>
      entry.event === "shortcut-b" && entry.defaultPrevented === true && entry.trusted === true,
    "page-prevented trusted browser shortcut",
  );
  await delay(100);
  const pagePreventedHostState = await win.webContents.executeJavaScript(
    "window.captureHarness.hostBrowserShortcutState()",
    true,
  );
  if (
    shortcutInputs.length !== 0 ||
    pagePreventedHostState.events !== 0 ||
    sentinel.applicationMenuShortcutHits !== 0
  ) {
    fail(
      `page-prevented browser shortcut escaped guest: inputs=${JSON.stringify(shortcutInputs)} host=${JSON.stringify(pagePreventedHostState)} menu=${sentinel.applicationMenuShortcutHits}`,
    );
  }
  pass("automation page preventDefault keeps browser shortcut in the guest");
  checks.push({ group: "automation", check: "browser-shortcut-page-prevented", pass: true });

  checks.push(await verifyLatePageShortcutFirstRefusal({ guest, sentinel, shortcutInputs }));

  await guest.executeJavaScript("window.preventBrowserShortcut = false", true);
  const unhandledTarget = await guest.executeJavaScript(
    "document.getElementById('save').focus(); document.activeElement.id",
    true,
  );
  if (unhandledTarget !== "save") {
    fail(`automation unhandled browser shortcut target was not focused: ${unhandledTarget}`);
  }
  automationBrowserShortcut(guest);
  await waitForAutomationLog(
    guest,
    (entry) =>
      entry.event === "shortcut-b" && entry.defaultPrevented === false && entry.trusted === true,
    "unhandled trusted browser shortcut",
  );
  await waitForBrowserShortcutInput(shortcutInputs, 1);
  await delay(100);
  const unhandledHostState = await win.webContents.executeJavaScript(
    "window.captureHarness.hostBrowserShortcutState()",
    true,
  );
  const expectedBrowserShortcutInput = {
    alt: false,
    browserId,
    code: "KeyB",
    control: !usesMeta,
    key: "b",
    meta: usesMeta,
    repeat: false,
    shift: false,
  };
  if (
    shortcutInputs.length !== 1 ||
    !isDeepStrictEqual(shortcutInputs[0], expectedBrowserShortcutInput) ||
    unhandledHostState.events !== 0 ||
    sentinel.applicationMenuShortcutHits !== 0
  ) {
    fail(
      `unhandled browser shortcut crossed boundary incorrectly: inputs=${JSON.stringify(shortcutInputs)} host=${JSON.stringify(unhandledHostState)} menu=${sentinel.applicationMenuShortcutHits}`,
    );
  }
  pass("automation production guest preload forwards one page-unhandled browser shortcut");
  checks.push({ group: "automation", check: "browser-shortcut-page-first-forward", pass: true });

  const editableTarget = await guest.executeJavaScript(
    `(() => {
      const editable = document.querySelector("p");
      editable.contentEditable = "true";
      editable.focus();
      const range = document.createRange();
      range.selectNodeContents(editable);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return document.activeElement === editable;
    })()`,
    true,
  );
  if (!editableTarget) {
    fail("automation editable browser shortcut target was not focused");
  }
  automationBrowserShortcut(guest);
  await waitForBrowserShortcutInput(shortcutInputs, 2);
  await delay(100);
  const editableState = await guest.executeJavaScript(
    `(() => {
      const editable = document.querySelector("p");
      return { bold: document.queryCommandState("bold"), html: editable.innerHTML };
    })()`,
    true,
  );
  if (
    !isDeepStrictEqual(shortcutInputs[1], expectedBrowserShortcutInput) ||
    !isDeepStrictEqual(editableState, { bold: false, html: "Connected as Maya" })
  ) {
    fail(
      `editable browser shortcut crossed boundary incorrectly: inputs=${JSON.stringify(shortcutInputs)} editable=${JSON.stringify(editableState)}`,
    );
  }
  pass("automation guest preload owns an unhandled editable browser shortcut");
  checks.push({ group: "automation", check: "browser-shortcut-editable-owned", pass: true });

  checks.push(await verifyEditableShortcutExclusion({ guest, shortcutInputs }));

  automationBrowserShortcut(guest, "1");
  await waitForBrowserShortcutInput(shortcutInputs, 3);
  const expectedDigitShortcutInput = {
    alt: false,
    browserId,
    code: "Digit1",
    control: !usesMeta,
    key: "1",
    meta: usesMeta,
    repeat: false,
    shift: false,
  };
  if (!isDeepStrictEqual(shortcutInputs[2], expectedDigitShortcutInput)) {
    fail(
      `digit browser shortcut crossed boundary incorrectly: inputs=${JSON.stringify(shortcutInputs)}`,
    );
  }
  pass("automation production guest preload forwards digit wildcard shortcuts");
  checks.push({ group: "automation", check: "browser-shortcut-digit-wildcard", pass: true });

  checks.push(
    await verifyFocusedIframeShortcut({
      guest,
      shortcutInputs,
      expectedInput: expectedBrowserShortcutInput,
    }),
  );

  const focusedGuestInput = await guest.executeJavaScript(
    "document.getElementById('name').focus(); document.activeElement.id",
    true,
  );
  const focusedHostInput = await win.webContents.executeJavaScript(
    "window.captureHarness.focusHostComposer()",
    true,
  );
  const retainedGuestInput = await guest.executeJavaScript("document.activeElement.id", true);
  if (
    focusedGuestInput !== "name" ||
    focusedHostInput !== "host-composer" ||
    retainedGuestInput !== "name"
  ) {
    fail(
      `automation focus setup guest=${JSON.stringify(focusedGuestInput)} host=${JSON.stringify(focusedHostInput)} retainedGuest=${JSON.stringify(retainedGuestInput)}`,
    );
  }
  sendContainedEnter(guest);
  await waitForAutomationLog(
    guest,
    (entry) => entry.event === "keydown-name" && entry.key === "Enter" && entry.trusted === true,
    "trusted guest Enter",
  );
  const hostComposerState = await win.webContents.executeJavaScript(
    "window.captureHarness.hostComposerState()",
    true,
  );
  const expectedHostComposerState = {
    activeElementId: "host-composer",
    enterEvents: 0,
    submissions: 0,
  };
  if (!isDeepStrictEqual(hostComposerState, expectedHostComposerState)) {
    fail(`automation guest Enter reached host composer: ${JSON.stringify(hostComposerState)}`);
  }
  pass("automation guest Enter does not reach the active host composer");
  checks.push({ group: "automation", check: "guest-enter-host-isolation", pass: true });

  win.hide();
  await delay(50);
  if (win.isFocused()) {
    fail("automation harness window stayed focused after hide");
  }
  await guest.executeJavaScript("document.getElementById('name').focus()", true);
  sendContainedEnter(guest);
  await waitForAutomationLog(
    guest,
    (entry) => entry.event === "keydown-name" && entry.key === "Enter" && entry.trusted === true,
    "trusted background guest Enter",
  );
  const hiddenHostComposerState = await win.webContents.executeJavaScript(
    "window.captureHarness.hostComposerState()",
    true,
  );
  if (!isDeepStrictEqual(hiddenHostComposerState, expectedHostComposerState)) {
    fail(
      `automation background guest Enter reached host composer: ${JSON.stringify(hiddenHostComposerState)}`,
    );
  }
  pass("automation background guest Enter stays in the guest");
  checks.push({ group: "automation", check: "background-guest-enter", pass: true });

  return checks;
}

async function runAutomationGroup() {
  const results = [];
  const { BrowserKeyboard } = require(PRODUCTION_BROWSER_KEYBOARD_PATH);
  const { PaseoBrowserWebviewRegistry } = require(PRODUCTION_BROWSER_WEBVIEW_REGISTRY_PATH);
  const browserRegistry = new PaseoBrowserWebviewRegistry();
  const browserKeyboard = new BrowserKeyboard(browserRegistry);
  browserKeyboard.registerIpc();
  const browserKeyboardSentinels = installBrowserKeyboardSentinels();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win, {
    preloadPath: PRODUCTION_BROWSER_GUEST_PRELOAD_PATH,
  });
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: {
          webviewCount: "0",
          permanentParkingState: "p1-overflow-1x1",
          targetUrl: automationFixtureUrl(),
        },
      }),
      "automation harness window loadFile",
    );
    await waitForInactiveReveal(handle, "automation harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: automationFixtureUrl(),
    });
    await waitForGuestLoad(guest);
    browserKeyboardSentinels.state.guestId = guest.id;

    const browserId = "capture-harness-browser";
    const usesMeta = process.platform === "darwin";
    browserRegistry.registerWebContents({
      browserId,
      hostWebContentsId: win.webContents.id,
      webContentsId: guest.id,
    });
    browserKeyboard.attach({ contents: guest, hostContents: win.webContents });
    browserKeyboard.publish(win.webContents.id, {
      menuPrefixes: [
        {
          alt: false,
          code: "KeyB",
          control: !usesMeta,
          key: "b",
          meta: usesMeta,
          repeat: false,
          shift: false,
        },
      ],
      prefixes: [
        {
          alt: false,
          code: "KeyB",
          control: !usesMeta,
          key: "b",
          meta: usesMeta,
          repeat: false,
          shift: false,
        },
        {
          alt: false,
          code: "ArrowLeft",
          control: !usesMeta,
          editable: false,
          meta: usesMeta,
          repeat: false,
          shift: true,
        },
        {
          alt: false,
          code: "Digit",
          control: !usesMeta,
          meta: usesMeta,
          repeat: false,
          shift: false,
        },
      ],
    });
    await delay(25);

    const first = await guest.executeJavaScript(AUTOMATION_SNAPSHOT_PROBE, true);
    assertAutomationSnapshot(first);
    pass("automation snapshot renders headings static text controls and refs");
    results.push({ group: "automation", check: "snapshot", pass: true });

    const saveRef = first.refs.find((ref) => ref.fingerprint.name === "Save changes");
    if (!saveRef) {
      fail("automation save ref missing");
    }
    await guest.executeJavaScript("window.pushFixtureState()", true);
    const pushStateResult = await guest.executeJavaScript(
      `window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(saveRef.ref)}, ${JSON.stringify(saveRef.fingerprint)}).ok`,
      true,
    );
    if (pushStateResult !== true) {
      fail("automation ref did not survive pushState");
    }
    pass("automation ref resolves after pushState");
    results.push({ group: "automation", check: "pushState-ref", pass: true });

    const pageEvaluate = await automationEvaluate(guest, "() => ({ title: document.title })");
    const refEvaluate = await automationEvaluate(
      guest,
      "(element) => ({ text: element.textContent.trim(), tag: element.tagName.toLowerCase() })",
      saveRef,
    );
    if (
      pageEvaluate !== '{"title":"Automation Fixture"}' ||
      refEvaluate !== '{"text":"Save changes","tag":"button"}'
    ) {
      fail(`automation evaluate returned page=${pageEvaluate} ref=${refEvaluate}`);
    }
    pass("automation evaluate runs in page context and receives ref element");
    results.push({ group: "automation", check: "evaluate", pass: true });

    await guest.executeJavaScript("window.scrollTo(0, 0)", true);
    await automationScroll(guest, 0, 500);
    await delay(100);
    const scrollY = await guest.executeJavaScript("window.scrollY", true);
    if (!(scrollY > 0)) {
      fail(`automation scroll did not change window.scrollY: ${scrollY}`);
    }
    pass("automation scroll changes the viewport scroll position");
    results.push({ group: "automation", check: "scroll", pass: true });

    const nameRef = automationRefByName(first, "Name");
    await automationType(guest, nameRef, " Ada");
    await automationClick(guest, saveRef);
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "input-name" && entry.trusted === true,
      "trusted input event",
    );
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "click-save" && entry.trusted === true,
      "trusted click event",
    );
    pass("automation trusted click and text input events reach the page");
    results.push({ group: "automation", check: "trusted-input", pass: true });

    const hoverRef = automationRefByName(first, "Reveal actions");
    await automationHover(guest, hoverRef);
    const hoverVisible = await guest.executeJavaScript(
      "getComputedStyle(document.getElementById('hover-target')).display !== 'none'",
      true,
    );
    if (hoverVisible !== true) {
      fail("automation hover did not reveal the hover target");
    }
    pass("automation hover reveals CSS :hover content");
    results.push({ group: "automation", check: "hover-reveal", pass: true });

    const delayedRef = automationRefByName(first, "Delayed save");
    await automationClick(guest, delayedRef);
    const delayedLog = await automationLog(guest);
    if (!delayedLog.some((entry) => entry.event === "click-delayed" && entry.trusted === true)) {
      fail("automation delayed enabled button did not receive trusted click");
    }
    pass("automation action waits for delayed enabled state");
    results.push({ group: "automation", check: "delayed-enable", pass: true });

    const movingRef = automationRefByName(first, "Moving target");
    await automationClick(guest, movingRef);
    const movingLog = await automationLog(guest);
    if (!movingLog.some((entry) => entry.event === "click-moving" && entry.trusted === true)) {
      fail("automation moving button did not receive trusted click");
    }
    pass("automation action waits for moving element stabilization");
    results.push({ group: "automation", check: "moving-stable", pass: true });

    const dragSourceRef = automationRefByName(first, "Drag source");
    const dragTargetRef = automationRefByName(first, "Drop target");
    await automationDrag(guest, dragSourceRef, dragTargetRef);
    const dragLog = await automationLog(guest);
    if (
      !dragLog.some((entry) => entry.event === "drag-down" && entry.trusted === true) ||
      !dragLog.some((entry) => entry.event === "drag-up" && entry.trusted === true)
    ) {
      fail("automation pointer drag did not produce trusted pointer events");
    }
    pass("automation pointer-event drag reaches source and target");
    results.push({ group: "automation", check: "pointer-drag", pass: true });

    await automationClick(guest, saveRef, {
      button: "right",
      doubleClick: true,
      modifiers: ["Control", "Shift"],
    });
    const optionsLog = await automationLog(guest);
    if (
      !optionsLog.some(
        (entry) =>
          entry.event === "down-save" &&
          entry.trusted === true &&
          entry.button === 2 &&
          entry.detail === 2 &&
          entry.ctrlKey === true &&
          entry.shiftKey === true,
      )
    ) {
      fail("automation click options did not affect button/modifiers/double-click count");
    }
    pass("automation click options affect button modifiers and double-click count");
    results.push({ group: "automation", check: "click-options", pass: true });

    const alertRef = automationRefByName(first, "Open alert");
    const alertDialogs = await captureAutomationDialogs(
      guest,
      () => automationClick(guest, alertRef),
      1,
    );
    assertAutomationDialog(alertDialogs, {
      type: "alert",
      message: "Alert opened",
      action: "accepted",
    });
    await waitForAutomationLog(guest, (entry) => entry.event === "alert-returned", "alert return");
    pass("automation alert dialogs are accepted and reported");
    results.push({ group: "automation", check: "dialog-alert", pass: true });

    const confirmRef = automationRefByName(first, "Open confirm");
    const confirmDialogs = await captureAutomationDialogs(
      guest,
      () => automationClick(guest, confirmRef),
      1,
    );
    assertAutomationDialog(confirmDialogs, {
      type: "confirm",
      message: "Confirm action?",
      action: "dismissed",
    });
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "confirm-result" && entry.value === false,
      "confirm dismissal",
    );
    pass("automation confirm dialogs are dismissed and reported");
    results.push({ group: "automation", check: "dialog-confirm", pass: true });

    const promptRef = automationRefByName(first, "Open prompt");
    const promptDialogs = await captureAutomationDialogs(
      guest,
      () => automationClick(guest, promptRef),
      1,
    );
    assertAutomationDialog(promptDialogs, {
      type: "prompt",
      message: "Prompt value?",
      defaultValue: "Maya",
      action: "dismissed",
    });
    await waitForAutomationLog(
      guest,
      (entry) => entry.event === "prompt-result" && entry.value === null,
      "prompt dismissal",
    );
    pass("automation prompt dialogs are dismissed and reported");
    results.push({ group: "automation", check: "dialog-prompt", pass: true });

    const beforeUnloadRef = automationRefByName(first, "Arm beforeunload");
    await automationClick(guest, beforeUnloadRef);
    const beforeUrl = guest.getURL();
    const beforeUnloadDialogs = await captureAutomationDialogs(
      guest,
      async () => {
        await guest.loadURL(automationFixtureUrl()).catch(() => {});
      },
      1,
    );
    assertAutomationDialog(beforeUnloadDialogs, {
      type: "beforeunload",
      action: "dismissed",
    });
    if (guest.getURL() !== beforeUrl) {
      fail("automation beforeunload dismissal did not cancel navigation");
    }
    pass("automation beforeunload dialogs are dismissed and reported");
    results.push({ group: "automation", check: "dialog-beforeunload", pass: true });

    results.push(await verifyBackgroundAutomationInputIsolation({ guest, win, browserId }));

    await guest.executeJavaScript("window.sameUrlRerender()", true);
    const rerenderResult = await guest.executeJavaScript(
      `window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(saveRef.ref)}, ${JSON.stringify(saveRef.fingerprint)}).reason`,
      true,
    );
    if (rerenderResult !== "stale_ref") {
      fail(`automation same-url rerender returned ${rerenderResult}`);
    }
    pass("automation same-url rerender stales old ref");
    results.push({ group: "automation", check: "same-url-stale-ref", pass: true });

    const second = await guest.executeJavaScript(AUTOMATION_SNAPSHOT_PROBE, true);
    const uploadRef = second.refs.find((ref) => ref.fingerprint.name === "Upload receipt");
    if (!uploadRef) {
      fail("automation upload ref missing");
    }
    if (!guest.debugger.isAttached()) {
      guest.debugger.attach("1.3");
    }
    const evaluated = await guest.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => window.__PASEO_BROWSER_AUTOMATION__.resolve(${JSON.stringify(uploadRef.ref)}, ${JSON.stringify(uploadRef.fingerprint)}).element)()`,
      objectGroup: "paseo-browser-automation",
      returnByValue: false,
    });
    const described = await guest.debugger.sendCommand("DOM.describeNode", {
      objectId: evaluated.result.objectId,
    });
    if (!described.node || typeof described.node.backendNodeId !== "number") {
      fail("automation upload ref did not resolve to backendNodeId");
    }
    pass("automation upload ref resolves to backendNodeId");
    results.push({ group: "automation", check: "upload-backend-node", pass: true });

    await win.webContents.executeJavaScript(
      "document.querySelector('webview')?.focus({ preventScroll: true })",
      true,
    );
    const browserKeyboardChecks = await verifyBrowserKeyboardIsolation({
      guest,
      win,
      browserId,
      usesMeta,
      sentinel: browserKeyboardSentinels.state,
    });
    results.push(...browserKeyboardChecks);

    // Resize is not harness-testable: the harness hosts webviews in the parked
    // 1px resident host, and Electron does not propagate CSS-box resizes to a
    // parked guest's capture surface (see docs/browser-capture-harness.md).
    // The production resize path is app-owned webview sizing, covered by
    // packages/app/src/desktop/browser/automation/handler.test.ts.

    await fsp.writeFile(
      path.join(OUT_DIR, "automation-results.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    );
    return results;
  } finally {
    browserKeyboard.detachHost(win.webContents.id);
    browserKeyboardSentinels.restore();
    await closeHarnessWindow(win);
  }
}

function assertAutomationSnapshot(snapshot) {
  const text = snapshot && snapshot.snapshot;
  if (typeof text !== "string") {
    fail("automation snapshot returned no text");
  }
  for (const expected of [
    'heading "Settings"',
    'text: "Connected as Maya"',
    'textbox "Name" [ref=@e1]',
    'link "Read docs"',
    'button "Save changes"',
    'button "Upload receipt"',
  ]) {
    if (!text.includes(expected)) {
      fail(`automation snapshot missing ${expected}`);
    }
  }
  if (text.includes("selector")) {
    fail("automation snapshot exposed selector text");
  }
}

async function createBrowserProfileHarnessWindow(partition, sourceUrl) {
  const handle = createInactiveHarnessWindow({
    width: 640,
    height: 480,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win);
  const guestsPromise = tracker.waitForAttachedGuests(2);
  await withTimeout(
    win.loadFile(path.join(ROOT, "index.html"), {
      query: {
        webviewCount: "2",
        targetUrl: sourceUrl,
        profilePartition: partition,
        profileBrowserIds: "browser-first,browser-second",
      },
    }),
    "browser profile window loadFile",
  );
  await waitForInactiveReveal(handle, "browser profile window");
  const [guests, identities] = await withTimeout(
    Promise.all([guestsPromise, renderer(win, "window.captureHarness.profileIdentities()")]),
    "browser profile did-attach",
    BROWSER_PROFILE_TIMEOUT_MS,
  );
  return { handle, guests, identities };
}

async function readBrowserProfileFixture(guest) {
  return await guest.executeJavaScript(`({
    cookie: document.cookie,
    localStorage: localStorage.getItem("paseo-browser-profile")
  })`);
}

function assertBrowserProfileFixture(state, expectedValue, label) {
  if (state.localStorage !== expectedValue) {
    fail(`${label} localStorage mismatch ${JSON.stringify(state)}`);
  }
  if (!state.cookie.split("; ").includes(`paseo-browser-profile=${expectedValue}`)) {
    fail(`${label} cookie mismatch ${JSON.stringify(state)}`);
  }
}

function resolveBrowserProfileGuests(profileWindow, profileSession) {
  if (profileWindow.identities.length !== 2 || profileWindow.guests.length !== 2) {
    fail("browser profile harness did not attach exactly two guests");
  }
  const guestsById = new Map(profileWindow.guests.map((guest) => [guest.id, guest]));
  const [firstIdentity, secondIdentity] = profileWindow.identities;
  const firstGuest = guestsById.get(firstIdentity.webContentsId);
  const secondGuest = guestsById.get(secondIdentity.webContentsId);
  if (!firstGuest || !secondGuest) {
    fail("browser profile renderer identities did not map to attached main-process guests");
  }
  if (
    firstIdentity.browserId !== "browser-first" ||
    firstIdentity.webContentsId !== firstGuest.id
  ) {
    fail(
      `browser profile first attach mismatch ${JSON.stringify(firstIdentity)} main=${firstGuest.id}`,
    );
  }
  if (
    secondIdentity.browserId !== "browser-second" ||
    secondIdentity.webContentsId !== secondGuest.id
  ) {
    fail(
      `browser profile second attach mismatch ${JSON.stringify(secondIdentity)} main=${secondGuest.id}`,
    );
  }
  if (
    firstGuest.hostWebContents !== profileWindow.handle.win.webContents ||
    secondGuest.hostWebContents !== profileWindow.handle.win.webContents
  ) {
    fail("browser profile guests were not owned by their renderer");
  }
  if (firstGuest.session !== profileSession || secondGuest.session !== profileSession) {
    fail("browser profile guests did not share the persistent session");
  }
  return [firstGuest, secondGuest];
}

async function prepareBrowserProfileValue(firstGuest, profileSession) {
  if (BROWSER_PROFILE_PHASE === "read") {
    return (await fsp.readFile(BROWSER_PROFILE_VALUE_FILE, "utf8")).trim();
  }

  const profileValue = `profile-${Date.now()}-${process.pid}`;
  await firstGuest.executeJavaScript(`(() => {
    const value = ${JSON.stringify(profileValue)};
    localStorage.setItem("paseo-browser-profile", value);
    document.cookie = "paseo-browser-profile=" + value + "; Max-Age=86400; SameSite=Lax";
  })()`);
  if (BROWSER_PROFILE_PHASE === "write") {
    await fsp.writeFile(BROWSER_PROFILE_VALUE_FILE, `${profileValue}\n`);
    await profileSession.cookies.flushStore();
  }
  return profileValue;
}

async function runBrowserProfileGroup() {
  if (!["write", "read"].includes(BROWSER_PROFILE_PHASE)) {
    fail(`unknown browser profile phase ${BROWSER_PROFILE_PHASE}`);
  }
  const partition = "persist:paseo-browser-profile-harness-restart";
  const profileSession = session.fromPartition(partition);
  const fixture = await startBrowserProfileServer();
  const windows = [];
  try {
    if (BROWSER_PROFILE_PHASE === "write") {
      await profileSession.clearStorageData();
      await profileSession.clearCache();
    }
    const profileWindow = await createBrowserProfileHarnessWindow(partition, fixture.origin);
    windows.push(profileWindow.handle);
    const [firstGuest, secondGuest] = resolveBrowserProfileGuests(profileWindow, profileSession);
    await Promise.all([waitForGuestLoad(firstGuest), waitForGuestLoad(secondGuest)]);

    const profileValue = await prepareBrowserProfileValue(firstGuest, profileSession);

    const firstState = await readBrowserProfileFixture(firstGuest);
    const secondState = await readBrowserProfileFixture(secondGuest);
    assertBrowserProfileFixture(firstState, profileValue, "browser profile first tab");
    assertBrowserProfileFixture(secondState, profileValue, "browser profile second tab");

    pass("browser profile renderer did-attach identities match their main-process guests");
    pass("browser profile tabs share cookies, localStorage, and one persistent session");
    if (BROWSER_PROFILE_PHASE === "read") {
      pass("browser profile cookies and localStorage survived an Electron process restart");
    }
    const results = [
      { group: "browser-profile", check: "renderer-main-identity", pass: true },
      { group: "browser-profile", check: "shared-profile-data", pass: true },
    ];
    if (BROWSER_PROFILE_PHASE === "read") {
      results.push({
        group: "browser-profile",
        check: "process-restart-persistence",
        pass: true,
      });
    }
    return results;
  } finally {
    for (const handle of windows) {
      await closeHarnessWindow(handle.win);
    }
    if (BROWSER_PROFILE_PHASE !== "write") {
      await profileSession.clearStorageData();
      await profileSession.clearCache();
    }
    await closeServer(fixture.server);
  }
}

// Two origins: the page and its cart frame share one, the payment frame is on
// the other, so the page cannot reach into it.
async function startFramesNetworkServers() {
  const listen = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
  };
  const html = (response, body) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  };
  const cross = await listen((_request, response) =>
    html(response, "<!doctype html><title>Payment</title><button>Pay now</button>"),
  );
  const page = await listen((request, response) => {
    if (request.url?.startsWith("/x/")) {
      handleNetworkExportFixture(request, response);
      return;
    }
    if (request.url === "/api/cart" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const sku = JSON.parse(body).sku;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, items: [{ sku, qty: 1 }] }));
      });
      return;
    }
    if (request.url === "/inner") {
      html(
        response,
        `<!doctype html><title>Inner</title>
        <style>body { margin: 0; } #checkout { margin: 50px 0 0 90px; width: 160px; height: 40px; }</style>
        <p>Inside the cart frame</p>
        <input id="coupon" aria-label="Coupon">
        <input id="attachment" type="file" aria-label="Attachment">
        <button id="checkout">Checkout</button>
        <script>
          window.__frameLog = [];
          document.getElementById('checkout').addEventListener('click', (event) => {
            window.__frameLog.push({ event: 'click', trusted: event.isTrusted, x: event.clientX, y: event.clientY });
          });
          document.getElementById('coupon').addEventListener('input', (event) => {
            window.__frameLog.push({ event: 'input', value: event.target.value });
          });
        </script>`,
      );
      return;
    }
    html(
      response,
      `<!doctype html><title>Frames Fixture</title>
      <style>
        body { margin: 0; }
        iframe { display: block; margin: 30px 0 0 110px; border: 4px solid #888; padding: 6px; }
        #cart { width: 520px; height: 240px; }
        #payment { width: 300px; height: 80px; }
      </style>
      <h1>Frames fixture</h1>
      <iframe id="cart" title="Cart" src="/inner"></iframe>
      <iframe id="payment" title="Payment" src="${cross.origin}/pay"></iframe>`,
    );
  });
  page.server.on("upgrade", (request, socket) => {
    if (request.url === "/x/ws") acceptEchoWebSocket(request, socket);
    else socket.destroy();
  });
  return { page, cross };
}

const EXPORT_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Delta 99 export fixture: credentials the exported file must never contain.
const EXPORT_FIXTURE = {
  cookie: "sid-cookie-0123456789abcdef",
  bearer: "bearer-token-9f8e7d6c5b4a3210",
  password: "hunter2-correct-horse",
};

function handleNetworkExportFixture(request, response) {
  const json = (status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/x/app" || request.url === "/x/second") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(request.url === "/x/app"
        ? { "set-cookie": `sid=${EXPORT_FIXTURE.cookie}; HttpOnly; Path=/` }
        : {}),
    });
    // The data: image never touches the network: the export must leave it out and count it.
    response.end(
      `<!doctype html><title>${request.url}</title><h1>${request.url}</h1>${request.url === "/x/app" ? `<img alt="pixel" src="data:image/png;base64,${EXPORT_PIXEL_BASE64}">` : ""}`,
    );
    return;
  }
  if (request.headers.authorization !== `Bearer ${EXPORT_FIXTURE.bearer}`) {
    json(401, { error: "unauthorized" });
    return;
  }
  const items = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Beta" },
  ];
  const item = /^\/x\/api\/items\/(\d+)$/.exec(request.url ?? "");
  const bulk = /^\/x\/api\/bulk\/(\d+)$/.exec(request.url ?? "");
  if (request.url === "/x/api/items") {
    json(200, { items }, { "x-total-count": String(items.length) });
  } else if (item) {
    json(200, items.find((candidate) => candidate.id === Number(item[1])) ?? {});
  } else if (bulk) {
    json(200, { id: Number(bulk[1]), filler: "z".repeat(2000) });
  } else if (request.url === "/x/api/old") {
    response.writeHead(302, { location: "/x/api/items/1" });
    response.end();
  } else if (request.url === "/x/api/login" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      // A careless server echoing the password: the export must still not contain it.
      json(200, { ok: true, user: parsed.username, echo: parsed.password });
    });
  } else {
    json(404, { error: "missing" });
  }
}

// RFC 6455 just far enough for the fixture: unfragmented frames under 126 bytes, echoed back.
function acceptEchoWebSocket(request, socket) {
  const accept = require("node:crypto")
    .createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const frame = (opcode, payload) =>
    Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 6) {
      const opcode = pending[0] & 0x0f;
      const length = pending[1] & 0x7f;
      if (pending.length < 6 + length) return;
      const mask = pending.subarray(2, 6);
      const payload = Buffer.from(
        pending.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]),
      );
      pending = pending.subarray(6 + length);
      if (opcode === 8) {
        socket.end(frame(8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 1) socket.write(frame(1, Buffer.from(`echo:${payload.toString("utf8")}`)));
      if (opcode === 2) socket.write(frame(2, payload));
    }
  });
  socket.on("error", () => {});
}

async function runFramesNetworkGroup() {
  const servers = await startFramesNetworkServers();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "frames harness window loadFile",
    );
    await waitForInactiveReveal(handle, "frames harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${servers.page.origin}/`,
    });
    await waitForGuestLoad(guest);
    const harness = createFramesAutomation(guest);
    const refs = await verifyFrameSnapshot(harness, servers);
    await verifyFrameClicks(harness, refs);
    await verifyFrameInputs(harness, refs);
    await verifyNetworkCapture(harness);
    const exportDetail = await verifyNetworkExport(harness, servers);
    const cost = await measureNetworkCaptureCost(harness, servers);
    return [
      ...["iframe-snapshot", "iframe-click", "iframe-actions", "network-capture"].map((check) => ({
        group: "frames-network",
        check,
        pass: true,
      })),
      { group: "frames-network", check: "network-export", pass: true, ...exportDetail },
      { group: "frames-network", check: "network-capture-cost", pass: true, ...cost },
    ];
  } finally {
    if (!win.isDestroyed()) win.close();
    await closeServer(servers.page.server);
    await closeServer(servers.cross.server);
  }
}

// Runs the compiled automation service against the guest, the way the desktop
// IPC handler does; `inputFocused` switches between background and trusted input.
function createFramesAutomation(guest) {
  const { executeAutomationCommand } = require(PRODUCTION_BROWSER_AUTOMATION_SERVICE_PATH);
  const { adaptWebContents } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const { BrowserSnapshotEngine } = require(PRODUCTION_BROWSER_SNAPSHOT_ENGINE_PATH);
  const browserId = "33333333-3333-4333-8333-333333333333";
  const workspaceId = "frames-harness-workspace";
  const tab = adaptWebContents(guest);
  const state = { inputFocused: false };
  const registry = {
    listRegisteredBrowserIds: () => [browserId],
    listRegisteredBrowserIdsForWorkspace: () => [browserId],
    getTabContents: (candidate) => (candidate === browserId ? tab : null),
    getBrowserWorkspaceId: (candidate) => (candidate === browserId ? workspaceId : null),
    getWorkspaceActiveBrowserId: () => (state.inputFocused ? browserId : null),
    isBrowserInputFocused: () => state.inputFocused,
    getBrowserTargetMetadata: () => ({ kind: "tab" }),
    networkExportEnvironment: () => ({ appVersion: "capture-harness", defaultDirectory: OUT_DIR }),
  };
  const snapshotEngine = new BrowserSnapshotEngine();
  let requestCounter = 0;
  const execute = (command) =>
    executeAutomationCommand(
      {
        type: "browser.automation.execute.request",
        requestId: `frames-${(requestCounter += 1)}`,
        workspaceId,
        cwd: OUT_DIR,
        command,
      },
      registry,
      { snapshotEngine },
    );
  return {
    guest,
    browserId,
    state,
    execute,
    async run(label, command) {
      const response = await execute(command);
      if (!response.ok) fail(`${label} failed: ${JSON.stringify(response)}`);
      return response.result;
    },
    frameEval: (expression) =>
      guest.executeJavaScript(
        `(() => { const w = document.getElementById('cart').contentWindow; return (${expression}); })()`,
        true,
      ),
  };
}

async function verifyFrameSnapshot(harness, servers) {
  const { browserId } = harness;
  const { snapshot } = await harness.run("frames snapshot", {
    command: "snapshot",
    args: { browserId },
  });
  const refOf = (line) => {
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ref = new RegExp(`${escaped} \\[ref=(@e\\d+)\\]`).exec(snapshot)?.[1];
    if (!ref) fail(`frames snapshot has no ref for ${line}:\n${snapshot}`);
    return ref;
  };
  const cartBlock = /- iframe "Cart"\n((?: {4}- .*\n?)+)/.exec(snapshot)?.[1] ?? "";
  const paymentLine = new RegExp(
    `^ {2}- iframe "Payment" \\[cross-origin=true src=${servers.cross.origin.replace(/[.]/g, "\\.")}/pay\\]$`,
    "m",
  );
  if (
    !cartBlock.includes('- text: "Inside the cart frame"') ||
    !/- textbox "Coupon" \[ref=@e\d+\]/.test(cartBlock) ||
    !/- button "Checkout" \[ref=@e\d+\]/.test(cartBlock) ||
    !paymentLine.test(snapshot) ||
    !/^ {4}- button "Pay now" \[ref=@f\d+e\d+\]$/m.test(snapshot)
  ) {
    fail(`frames snapshot shape wrong:\n${snapshot}`);
  }
  pass(
    "snapshot lists same-origin iframe content with refs and cross-origin content with frame refs",
  );
  return {
    checkout: refOf('button "Checkout"'),
    coupon: refOf('textbox "Coupon"'),
    attachment: refOf('textbox "Attachment"'),
  };
}

async function verifyFrameClicks(harness, refs) {
  const { browserId, guest } = harness;
  const click = { command: "click", args: { browserId, ref: refs.checkout } };
  await harness.run("background click", click);
  const isolatedClick = await harness.frameEval("w.__frameLog.at(-1)");
  if (isolatedClick?.event !== "click" || isolatedClick.trusted !== false) {
    fail(`background click did not reach the inner handler: ${JSON.stringify(isolatedClick)}`);
  }
  pass("background click on an iframe ref runs the inner handler");

  // Trusted input is delivered at tab-viewport coordinates: the frame's
  // margin, border, and padding must be added to the inner point.
  harness.state.inputFocused = true;
  const trusted = await harness.run("trusted click", click);
  harness.state.inputFocused = false;
  const expected = await guest.executeJavaScript(
    `(() => {
      const frame = document.getElementById('cart');
      const outer = frame.getBoundingClientRect();
      const inner = frame.contentDocument.getElementById('checkout').getBoundingClientRect();
      return {
        x: outer.left + frame.clientLeft + 6 + inner.left + inner.width / 2,
        y: outer.top + frame.clientTop + 6 + inner.top + inner.height / 2,
      };
    })()`,
    true,
  );
  const trustedClick = await harness.frameEval("w.__frameLog.at(-1)");
  const offBy = Math.max(Math.abs(trusted.x - expected.x), Math.abs(trusted.y - expected.y));
  if (trustedClick?.event !== "click" || trustedClick.trusted !== true || offBy > 1) {
    fail(
      `trusted iframe click missed: result=${JSON.stringify(trusted)} expected=${JSON.stringify(expected)} log=${JSON.stringify(trustedClick)}`,
    );
  }
  pass("trusted click on an iframe ref lands on the inner element at tab coordinates");
}

async function verifyFrameInputs(harness, refs) {
  const { browserId } = harness;
  await harness.run("fill", {
    command: "fill",
    args: { browserId, ref: refs.coupon, value: "SAVE10" },
  });
  await harness.run("type", { command: "type", args: { browserId, ref: refs.coupon, text: "+" } });
  const couponValue = await harness.frameEval("w.document.getElementById('coupon').value");
  if (couponValue !== "SAVE10+") {
    fail(`fill/type inside the iframe produced ${JSON.stringify(couponValue)}`);
  }
  pass("fill and type on an iframe ref write into the inner input");

  await fsp.writeFile(path.join(OUT_DIR, "frames-upload.txt"), "upload fixture\n");
  await harness.run("upload", {
    command: "upload",
    args: { browserId, ref: refs.attachment, filePaths: ["frames-upload.txt"] },
  });
  const uploaded = await harness.frameEval(
    "w.document.getElementById('attachment').files[0]?.name",
  );
  const waited = await harness.run("wait", {
    command: "wait",
    args: { browserId, text: "Inside the cart frame" },
  });
  const evaluated = await harness.run("evaluate", {
    command: "evaluate",
    args: { browserId, ref: refs.coupon, function: "(element) => element.ownerDocument.title" },
  });
  if (
    uploaded !== "frames-upload.txt" ||
    waited.matched !== "text" ||
    evaluated.resultJson !== '"Inner"'
  ) {
    fail(`upload/wait/evaluate in iframe: ${JSON.stringify({ uploaded, waited, evaluated })}`);
  }
  pass("upload, wait text, and evaluate with an iframe ref reach the frame");
}

async function listCapturedCart(harness) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const listed = await harness.run("network list", {
      command: "network",
      args: {
        ...networkArgs(harness.browserId, "list"),
        urlIncludes: "/api/cart",
        includeBodies: true,
        includeRequestBodies: true,
      },
    });
    if (listed.entries[0]) return listed.entries[0];
    await delay(50);
  }
  return null;
}

function capturedCartProblems(entry) {
  if (!entry) return ["no entry"];
  const requestBody = JSON.parse(entry.requestBody ?? "null");
  const responseBody = JSON.parse(entry.responseBody ?? "null");
  const expectations = [
    [entry.method, "POST"],
    [entry.status, 200],
    [entry.resourceType, "fetch"],
    [entry.mimeType, "application/json"],
    [entry.requestHeaders.authorization, "<redacted>"],
    [requestBody?.sku, "A1"],
    [requestBody?.password, "<redacted>"],
    [responseBody?.items?.[0]?.sku, "A1"],
  ];
  return expectations
    .filter(([actual, wanted]) => actual !== wanted)
    .map(([actual, wanted]) => `${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
}

async function verifyNetworkCapture(harness) {
  const { browserId, guest } = harness;
  const notStarted = await harness.execute({
    command: "network",
    args: networkArgs(browserId, "list"),
  });
  if (notStarted.ok || !notStarted.error.message.includes('action "start"')) {
    fail(`network list before start: ${JSON.stringify(notStarted)}`);
  }
  await harness.run("network start", { command: "network", args: networkArgs(browserId, "start") });
  const fetched = await guest.executeJavaScript(
    `fetch('/api/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer s3cret' },
      body: JSON.stringify({ sku: 'A1', password: 'hunter2' }),
    }).then((response) => response.json())`,
    true,
  );
  const entry = await listCapturedCart(harness);
  const problems = capturedCartProblems(entry);
  if (fetched?.ok !== true || problems.length > 0) {
    fail(`captured request wrong (${problems.join("; ")}): ${JSON.stringify(entry)}`);
  }
  await harness.run("network stop", { command: "network", args: networkArgs(browserId, "stop") });
  const afterStop = await harness.execute({
    command: "network",
    args: networkArgs(browserId, "list"),
  });
  if (afterStop.ok) {
    fail("network list still answered after stop");
  }
  pass("network capture records a same-origin fetch with redacted credentials and its bodies");
}

// Counts the CDP commands the capture sends while `run` runs.
async function countCaptureCommands(guest, run) {
  const counts = {};
  const original = guest.debugger.sendCommand;
  guest.debugger.sendCommand = function countedSendCommand(method, ...rest) {
    counts[method] = (counts[method] ?? 0) + 1;
    return original.call(this, method, ...rest);
  };
  try {
    const value = await run();
    return { value, counts };
  } finally {
    guest.debugger.sendCommand = original;
  }
}

async function loadGuest(guest, url) {
  await withTimeout(guest.loadURL(url), `load ${url}`);
}

// Delta 99: a real capture across a navigation, exported, sanitized, and read back.
async function verifyNetworkExport(harness, servers) {
  const { browserId, guest } = harness;
  const origin = servers.page.origin;
  await harness.run("network start", { command: "network", args: networkArgs(browserId, "start") });
  const { value: flow, counts } = await countCaptureCommands(guest, async () => {
    await loadGuest(guest, `${origin}/x/app`);
    const result = await guest.executeJavaScript(
      `(async () => {
        const auth = { authorization: 'Bearer ${EXPORT_FIXTURE.bearer}' };
        // A body nobody reads never finishes loading, so each one is read.
        const statusOf = async (response) => {
          await response.text();
          return response.status;
        };
        const get = (path) => fetch(path, { headers: auth }).then(statusOf);
        const statuses = [];
        statuses.push(await get('/x/api/items'));
        statuses.push(await get('/x/api/items/1'));
        statuses.push(await get('/x/api/items/1'));
        statuses.push(await get('/x/api/items/2'));
        statuses.push(await fetch('/x/api/login', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'ada', password: '${EXPORT_FIXTURE.password}' }),
        }).then(statusOf));
        statuses.push(await get('/x/api/old'));
        statuses.push(await get('/x/api/missing'));
        const echoes = await new Promise((resolve, reject) => {
          const socket = new WebSocket(location.origin.replace('http', 'ws') + '/x/ws');
          const received = [];
          socket.onerror = () => reject(new Error('websocket failed'));
          socket.onopen = () => {
            for (const text of ['one', 'two', 'three']) socket.send(text);
            socket.send(new Uint8Array([1, 2, 3, 4]));
          };
          socket.onmessage = (event) => {
            received.push(typeof event.data === 'string' ? event.data : 'binary');
            if (received.length === 4) {
              socket.close();
              resolve(received);
            }
          };
        });
        return { statuses, echoes };
      })()`,
      true,
    );
    // The page goes away before the export: the API bodies must already be kept.
    await loadGuest(guest, `${origin}/x/second`);
    await delay(300);
    return result;
  });
  const exportPath = path.join(OUT_DIR, "network-export.har");
  await fsp.rm(exportPath, { force: true });
  const exported = await harness.run("network export", {
    command: "network_export",
    args: { browserId, path: exportPath, bodies: "api", includeWebSocket: true, overwrite: false },
  });
  const text = await fsp.readFile(exportPath, "utf8");
  const har = JSON.parse(text);
  const mode = (await fsp.stat(exportPath)).mode & 0o777;
  const problems = [
    ...exportFileProblems({ har, text, mode, exported, flow, exportPath }),
    ...exportEntryProblems(har.log.entries),
  ];
  if (problems.length > 0) {
    fail(`network export wrong (${problems.join("; ")}): ${JSON.stringify(exported)}`);
  }
  await verifyListAfterNavigation(harness);
  await harness.run("network stop", { command: "network", args: networkArgs(browserId, "stop") });
  const requestsSeen = har.log.entries.filter(
    (entry) => entry._resourceType !== "websocket",
  ).length;
  const extraCommands =
    (counts["Network.getResponseBody"] ?? 0) + (counts["Network.getRequestPostData"] ?? 0);
  pass(
    `network export writes a sanitized HAR across a navigation: ${har.log.entries.length} entries, ${har.log.pages.length} pages, ${exported.bytes} bytes, redactions ${JSON.stringify(exported.redactions)}, ${exported.skippedNonNetwork} non-network requests left out, ${extraCommands} body copies for ${requestsSeen} requests`,
  );
  return {
    path: exportPath,
    entries: har.log.entries.length,
    bytes: exported.bytes,
    redactions: exported.redactions,
    skippedNonNetwork: exported.skippedNonNetwork,
    cdpCommandsDuringFlow: counts,
    bodyCopiesPerRequest: Number((extraCommands / Math.max(1, requestsSeen)).toFixed(2)),
  };
}

function mismatches(pairs) {
  return pairs
    .map(([actual, wanted], index) =>
      actual === wanted ? null : `#${index} ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`,
    )
    .filter(Boolean);
}

function exportFileProblems({ har, text, mode, exported, flow, exportPath }) {
  const leaked = Object.entries(EXPORT_FIXTURE)
    .filter(([, secret]) => text.includes(secret) || text.includes(encodeURIComponent(secret)))
    .map(([name]) => name);
  return mismatches([
    [JSON.stringify(flow.statuses), JSON.stringify([200, 200, 200, 200, 200, 200, 404])],
    [JSON.stringify(flow.echoes), JSON.stringify(["echo:one", "echo:two", "echo:three", "binary"])],
    [har.log.version, "1.2"],
    [har.log.creator.name, "Daseo"],
    [har.log._daseo.sanitized, true],
    [har.log.pages.length, 2],
    [JSON.stringify(leaked), "[]"],
    [mode, 0o600],
    [exported.path, exportPath],
    [exported.entries, har.log.entries.length],
    // The pixel's bytes appear only in the HTML of the page that shows it, never as an entry.
    [
      har.log.entries
        .filter((entry) => JSON.stringify(entry).includes(EXPORT_PIXEL_BASE64))
        .map((entry) => new URL(entry.request.url).pathname)
        .join(","),
      "/x/app",
    ],
    [har.log.entries.some((entry) => !/^(https?|wss?):/.test(entry.request.url)), false],
    [exported.skippedNonNetwork >= 1, true],
    [har.log.comment.includes("non-network URLs are left out"), true],
  ]);
}

function headerValues(entry, side, name) {
  if (!entry) return [];
  return entry[side].headers
    .filter((item) => item.name.toLowerCase() === name)
    .map((item) => item.value);
}

function exportEntryProblems(entries) {
  const byUrl = (suffix) => entries.find((entry) => entry.request.url.endsWith(suffix));
  const items = byUrl("/x/api/items");
  const login = byUrl("/x/api/login");
  const redirect = byUrl("/x/api/old");
  const missing = byUrl("/x/api/missing");
  const appDocument = byUrl("/x/app");
  const socket = entries.find((entry) => entry._resourceType === "websocket");
  const messages = socket ? socket._webSocketMessages : [];
  const json = (entry) => JSON.parse(entry ? (entry.response.content.text ?? "null") : "null");
  return mismatches([
    [json(items)?.items?.[0]?.name, "Alpha"],
    [headerValues(items, "response", "x-total-count")[0], "2"],
    [/^Bearer <redacted-\d+>$/.test(headerValues(items, "request", "authorization")[0]), true],
    [/^sid=<redacted-\d+>$/.test(headerValues(items, "request", "cookie")[0]), true],
    [
      /^sid=<redacted-\d+>; HttpOnly; Path=\/$/.test(
        headerValues(appDocument, "response", "set-cookie")[0],
      ),
      true,
    ],
    [/^<redacted-\d+>$/.test(json(login)?.echo), true],
    [redirect?.response.status, 302],
    [redirect?.response.redirectURL, "/x/api/items/1"],
    [missing?.response.status, 404],
    [messages.filter((message) => message.type === "send").length, 4],
    [messages.filter((message) => message.type === "receive").length, 4],
    [messages.some((message) => message.opcode === 2 && message._binaryBytes === 4), true],
    [items?.pageref, "page_1"],
  ]);
}

// `list` reads the kept copy too: the body is there after the navigation.
async function verifyListAfterNavigation(harness) {
  const listed = await harness.run("network list after navigation", {
    command: "network",
    args: {
      ...networkArgs(harness.browserId, "list"),
      urlIncludes: "/x/api/items",
      includeBodies: true,
      includeResponseHeaders: true,
    },
  });
  const entry = listed.entries[0];
  const body = entry ? (entry.responseBody ?? "") : "";
  const total = entry && entry.responseHeaders ? entry.responseHeaders["x-total-count"] : undefined;
  if (!body.includes("Alpha") || total !== "2") {
    fail(`network list after navigation lost the body or headers: ${JSON.stringify(entry)}`);
  }
}

// V4: main-process memory a capture of about 150 API requests holds, and CDP commands per request.
async function measureNetworkCaptureCost(harness, servers) {
  const { browserId, guest } = harness;
  const v8 = require("node:v8");
  v8.setFlagsFromString("--expose-gc");
  const gc = require("node:vm").runInNewContext("gc");
  const heap = () => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  await loadGuest(guest, `${servers.page.origin}/x/second`);
  await harness.run("network start", { command: "network", args: networkArgs(browserId, "start") });
  const requests = 150;
  const before = heap();
  const { counts } = await countCaptureCommands(guest, async () => {
    await guest.executeJavaScript(
      `Promise.all(Array.from({ length: ${requests} }, (_, i) =>
        fetch('/x/api/bulk/' + i, { headers: { authorization: 'Bearer ${EXPORT_FIXTURE.bearer}' } }).then((r) => r.text())))`,
      true,
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const listed = await harness.run("network list bulk", {
        command: "network",
        args: { ...networkArgs(browserId, "list"), urlIncludes: "/x/api/bulk/", maxEntries: 200 },
      });
      if (listed.entries.length >= requests) return;
      await delay(100);
    }
    fail("bulk requests never all completed");
  });
  const held = heap();
  await harness.run("network stop", { command: "network", args: networkArgs(browserId, "stop") });
  const released = heap();
  const bodyCopies = counts["Network.getResponseBody"] ?? 0;
  const result = {
    requests,
    heapHeldBytes: held - released,
    heapGrowthBytes: held - before,
    getResponseBodyPerRequest: Number((bodyCopies / requests).toFixed(2)),
    cdpCommands: counts,
  };
  pass(`network capture cost ${JSON.stringify(result)}`);
  return result;
}

function networkArgs(browserId, action) {
  return { browserId, action, maxEntries: 50, includeBodies: false, includeRequestBodies: false };
}

// Delta 78 browser passkeys, through the production hub, CDP adapter, and automation service
// against real guests: a site with no stored passkey fails at once, a passkey a site registers is
// stored encrypted and signs in from another guest and after a navigation, and delete revokes it.
// Delta 102: a request started with no click or key (passkey autofill) waits and signs in nobody,
// browser_passkeys use answers it, a click on the site's passkey button signs in at once, and two
// stored accounts wait for a named choice.
const PASSKEY_PAGE = `<!doctype html><html><head><title>Passkey target</title></head><body>
  <h1>Passkey target</h1>
  <input aria-label="Username" autocomplete="username webauthn">
  <button onclick="window.__clickGet()">Sign in with a passkey</button>
  <a href="/login-view" onclick="event.preventDefault(); window.__spaSignIn()">Sign in</a>
  <script>
    // A client-side routed "Sign in" link (Turbo, an SPA router): the document stays, the login
    // view starts passkey autofill shortly after.
    window.__spaSignIn = () => {
      history.pushState({}, '', '/login-view');
      setTimeout(() => window.__cond(), 300);
    };
    const rnd = () => crypto.getRandomValues(new Uint8Array(32));
    // Passkey autofill, as login pages start it on load; the site's button aborts it first.
    window.__cond = () => {
      window.__condAbort = new AbortController();
      window.__condResult = undefined;
      navigator.credentials.get({ mediation: 'conditional', signal: window.__condAbort.signal,
        publicKey: { challenge: rnd(), rpId: 'localhost', userVerification: 'preferred' } })
        .then((a) => { window.__condResult = { ok: true, id: a.id }; },
              (e) => { window.__condResult = { ok: false, name: e.name }; });
      return 'started';
    };
    window.__modal = (slot) => {
      window[slot] = undefined;
      navigator.credentials.get({ publicKey: { challenge: rnd(), rpId: 'localhost',
        userVerification: 'preferred', timeout: 30000, allowCredentials: [] } })
        .then((a) => { window[slot] = { ok: true, id: a.id }; },
              (e) => { window[slot] = { ok: false, name: e.name }; });
      return 'started';
    };
    window.__clickGet = () => {
      if (window.__condAbort) window.__condAbort.abort();
      window.__modal('__clickResult');
    };
    if (location.search.includes('cond=1')) window.__cond();
    window.__create = async (name = 'alice@example.com') => {
      try {
        const cred = await navigator.credentials.create({ publicKey: {
          challenge: rnd(), rp: { id: 'localhost', name: 'harness' },
          user: { id: new TextEncoder().encode(name), name, displayName: name.split('@')[0] },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          timeout: 10000,
        }});
        return { ok: true, id: cred.id };
      } catch (e) { return { ok: false, name: e.name }; }
    };
    window.__get = async () => {
      const t0 = performance.now();
      try {
        const a = await Promise.race([
          navigator.credentials.get({ publicKey: {
            challenge: rnd(), rpId: 'localhost', userVerification: 'preferred', timeout: 10000, allowCredentials: [],
          }}),
          // A request with no authenticator environment never settles; the harness must.
          new Promise((_, reject) => setTimeout(() => reject(new DOMException('harness timeout', 'HarnessTimeoutError')), 8000)),
        ]);
        const data = new Uint8Array(a.response.authenticatorData);
        const counter = ((data[33] << 24) | (data[34] << 16) | (data[35] << 8) | data[36]) >>> 0;
        return { ok: true, id: a.id, counter, ms: Math.round(performance.now() - t0) };
      } catch (e) { return { ok: false, name: e.name, ms: Math.round(performance.now() - t0) }; }
    };
  </script></body></html>`;

async function startPasskeyServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PASSKEY_PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // WebAuthn needs https or literally "localhost".
  return { server, url: `http://localhost:${server.address().port}/` };
}

function createPasskeyAutomation(guest, browserId) {
  const { executeAutomationCommand } = require(PRODUCTION_BROWSER_AUTOMATION_SERVICE_PATH);
  const { adaptWebContents } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const { BrowserSnapshotEngine } = require(PRODUCTION_BROWSER_SNAPSHOT_ENGINE_PATH);
  const workspaceId = "passkeys-harness-workspace";
  const tab = adaptWebContents(guest);
  const registry = {
    listRegisteredBrowserIds: () => [browserId],
    listRegisteredBrowserIdsForWorkspace: () => [browserId],
    getTabContents: (candidate) => (candidate === browserId ? tab : null),
    getBrowserWorkspaceId: (candidate) => (candidate === browserId ? workspaceId : null),
    getWorkspaceActiveBrowserId: () => null,
    isBrowserInputFocused: () => false,
    getBrowserTargetMetadata: () => ({ kind: "tab" }),
  };
  const snapshotEngine = new BrowserSnapshotEngine();
  let requestCounter = 0;
  return async (label, command) => {
    const response = await executeAutomationCommand(
      {
        type: "browser.automation.execute.request",
        requestId: `passkeys-${(requestCounter += 1)}`,
        workspaceId,
        cwd: OUT_DIR,
        command,
      },
      registry,
      { snapshotEngine },
    );
    if (!response.ok) fail(`${label} failed: ${JSON.stringify(response)}`);
    return response.result;
  };
}

function createPasskeyHarnessHub() {
  const passkeys = require(path.join(PRODUCTION_BROWSER_AUTOMATION_DIR, "passkeys.js"));
  const { CdpSessionQueue } = require(
    path.join(PRODUCTION_BROWSER_AUTOMATION_DIR, "cdp-session-queue.js"),
  );
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-passkeys-harness-"));
  const storePath = path.join(storeDir, "browser-passkeys.json");
  // A fresh app key per run, as main.ts gets one from 1Password through the login shell env.
  const keyed = passkeys.PasskeyCipher.fromBase64(
    require("node:crypto").randomBytes(32).toString("base64"),
  );
  if (!keyed.ok) throw new Error(keyed.reason);
  const cipher = keyed.cipher;
  const store = new passkeys.PasskeyStore(storePath, cipher);
  const hub = new passkeys.PaseoBrowserPasskeys({
    store,
    log: (message, detail) => console.log(message, JSON.stringify(detail ?? {})),
    // As main.ts: which tab a request came from, to read that tab's user activation.
    contentsIdOfFrame: (frame) => require("electron").webContents.fromFrame(frame)?.id,
  });
  passkeys.setPaseoBrowserPasskeys(hub);
  return {
    passkeys,
    hub,
    store,
    storePath,
    attach: (contents) => {
      hub.bindSession(contents.session);
      hub.attach(contents, new CdpSessionQueue());
    },
    dispose: () => {
      passkeys.setPaseoBrowserPasskeys(null);
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function passkeyCheck(checks, name, problems, detail) {
  if (problems.length > 0)
    fail(`passkeys ${name} (${problems.join("; ")}): ${JSON.stringify(detail)}`);
  pass(`passkeys ${name}`);
  checks.push({ group: "passkeys", check: name, pass: true });
}

function passkeyProblems(pairs) {
  return pairs
    .filter(([actual, wanted]) => actual !== wanted)
    .map(([a, w]) => `${JSON.stringify(a)} != ${JSON.stringify(w)}`);
}

async function verifyPasskeyRegistration({ checks, first, harness, page }) {
  const emptyGet = await page(first, "__get()");
  passkeyCheck(
    checks,
    "a site with no stored passkey fails at once instead of hanging",
    passkeyProblems([
      [emptyGet.ok, false],
      [emptyGet.name, "NotAllowedError"],
      [emptyGet.ms < 2000, true],
    ]),
    emptyGet,
  );
  const created = await page(first, "__create()");
  const deadline = Date.now() + 3000;
  while (harness.store.list().length === 0 && Date.now() < deadline) await delay(50);
  const stored = harness.store.list()[0];
  passkeyCheck(
    checks,
    "a passkey the site registers is stored with its account",
    passkeyProblems([
      [created.ok, true],
      [stored?.credentialId, created.id],
      [stored?.rpId, "localhost"],
      [stored?.userName, "alice@example.com"],
    ]),
    { created, stored: stored && { ...stored, privateKey: "<omitted>" } },
  );
  const onDisk = fs.readFileSync(harness.storePath, "utf8");
  const mode = fs.statSync(harness.storePath).mode & 0o777;
  passkeyCheck(
    checks,
    "the private key is encrypted at rest",
    passkeyProblems([
      [JSON.parse(onDisk).version, 2],
      [JSON.parse(onDisk).cipher, "aes-256-gcm"],
      [onDisk.includes(harness.store.keyOf(stored.credentialId)), false],
      [mode, 0o600],
    ]),
    { mode: mode.toString(8) },
  );
  return { created, stored };
}

async function verifyPasskeyReuse({ checks, first, second, harness, page, url, created }) {
  const secondGet = await page(second, "__get()");
  passkeyCheck(
    checks,
    "another guest signs in with the stored passkey, no prompt",
    passkeyProblems([
      [secondGet.ok, true],
      [secondGet.id, created.id],
      [secondGet.ms < 2000, true],
    ]),
    secondGet,
  );
  // A query string makes this a real cross-document navigation (a same-URL load is folded
  // into a reload). loadURL resolves on did-finish-load, a moment before isLoading() turns
  // false, so waiting for another load event afterwards would wait forever.
  await withTimeout(first.loadURL(`${url}?again=1`), "first guest second loadURL", 10000);
  const loadDeadline = Date.now() + 5000;
  while (first.isLoading() && Date.now() < loadDeadline) await delay(20);
  await withTimeout(harness.hub.settle(first.id), "first guest reinstall settle", 10000);
  const afterNavigation = await withTimeout(page(first, "__get()"), "get after navigation", 12000);
  passkeyCheck(
    checks,
    "the authenticator survives a navigation and the counter keeps rising",
    passkeyProblems([
      [afterNavigation.ok, true],
      [afterNavigation.counter > secondGet.counter, true],
    ]),
    { afterNavigation, secondGet },
  );
}

// Polls a page global until it is set or the deadline passes; returns its last value.
async function pagePoll(guest, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await guest.executeJavaScript(expression, false);
    if (value !== undefined && value !== null) return value;
    await delay(50);
  } while (Date.now() < deadline);
  return value;
}

// Clicks a button the way browser_click does for an agent (background click, user gesture).
async function passkeyClick(run, browserId, name, role = "button") {
  const snapshot = await run("passkeys snapshot", {
    command: "snapshot",
    args: { browserId },
  });
  const ref = snapshot.snapshot?.match(new RegExp(`${role} "${name}" \\[ref=(@e\\d+)\\]`))?.[1];
  if (!ref) fail(`passkeys: no ref for ${role} "${name}" in ${snapshot.snapshot}`);
  return run(`click ${name}`, { command: "click", args: { browserId, ref } });
}

async function loadPasskeyPage(harness, guest, target) {
  await withTimeout(guest.loadURL(target), `passkeys loadURL ${target}`, 10000);
  const loadDeadline = Date.now() + 5000;
  while (guest.isLoading() && Date.now() < loadDeadline) await delay(20);
  await withTimeout(harness.hub.settle(guest.id), "passkeys reinstall settle", 10000);
}

async function verifyPasskeyAutofillWaits({
  checks,
  second,
  harness,
  url,
  created,
  run,
  browserId,
}) {
  // A login page that starts passkey autofill on load (GitHub's /login shape).
  await loadPasskeyPage(harness, second, `${url}?cond=1&on=load`);
  await delay(3000);
  const onLoad = await second.executeJavaScript("window.__condResult ?? null", false);
  const onLoadWaiting = harness.hub.waitingRequest(second.id);
  passkeyCheck(
    checks,
    "passkey autofill started on page load signs in nobody and waits (3 s)",
    passkeyProblems([
      [onLoad, null],
      [onLoadWaiting?.reason, "no_gesture"],
      [onLoadWaiting?.accounts?.[0]?.credentialId, created.id],
    ]),
    { onLoad, onLoadWaiting },
  );
  const status = await run("passkeys status (waiting)", {
    command: "passkeys",
    args: { action: "status", browserId },
  });
  const used = await run("passkey_use", { command: "passkey_use", args: { browserId } });
  const answered = await pagePoll(second, "window.__condResult", 3000);
  passkeyCheck(
    checks,
    "browser_passkeys use answers the waiting autofill request",
    passkeyProblems([
      [status.tab?.request?.reason, "no_gesture"],
      [status.tab?.request?.accounts?.[0]?.account, "al•••@example.com"],
      [used.outcome, "used"],
      [used.used?.credentialId, created.id],
      [answered?.ok, true],
      [answered?.id, created.id],
      [harness.hub.waitingRequest(second.id), null],
    ]),
    { status: status.tab, used, answered },
  );
  const none = await run("passkey_use (nothing waits)", {
    command: "passkey_use",
    args: { browserId },
  });
  // A modal request with no click (an auto-prompt on load) waits as well.
  await second.executeJavaScript("window.__modal('__noGesture')", false);
  await delay(1500);
  const noGesture = await second.executeJavaScript("window.__noGesture ?? null", false);
  passkeyCheck(
    checks,
    "a modal request with no click or key waits too, and nothing waits after use",
    passkeyProblems([
      [none.outcome, "none"],
      [noGesture, null],
      [harness.hub.waitingRequest(second.id)?.reason, "no_gesture"],
    ]),
    { none, noGesture },
  );
}

async function verifyPasskeyButton({ checks, second, harness, url, created, run, browserId }) {
  await loadPasskeyPage(harness, second, `${url}?cond=1&on=button`);
  await delay(500);
  const before = await second.executeJavaScript("window.__condResult ?? null", false);
  const started = Date.now();
  await passkeyClick(run, browserId, "Sign in with a passkey");
  const clicked = await pagePoll(second, "window.__clickResult", 3000);
  const condAfter = await pagePoll(second, "window.__condResult", 1000);
  passkeyCheck(
    checks,
    "a click on the site's passkey button signs in at once",
    passkeyProblems([
      [before, null],
      [clicked?.ok, true],
      [clicked?.id, created.id],
      [Date.now() - started < 3000, true],
      [condAfter?.name, "AbortError"],
      [harness.hub.waitingRequest(second.id), null],
    ]),
    { before, clicked, condAfter },
  );
}

async function verifyPasskeyAfterClientRoute({
  checks,
  second,
  harness,
  url,
  created,
  run,
  browserId,
}) {
  const surfaceEvents = [];
  harness.passkeys.setPaseoBrowserPasskeyChoiceSurface({
    show: (request) => surfaceEvents.push(`show ${request.reason} ${request.accounts.length}`),
    hide: () => surfaceEvents.push("hide"),
  });
  await loadPasskeyPage(harness, second, url);
  const routed = await passkeyClick(run, browserId, "Sign in", "link");
  await delay(3000);
  const signedIn = await second.executeJavaScript("window.__condResult ?? null", false);
  const location = await second.executeJavaScript("location.pathname", false);
  const waiting = harness.hub.waitingRequest(second.id);
  const status = await run("passkeys status (after route)", {
    command: "passkeys",
    args: { action: "status", browserId },
  });
  const used = await run("passkey_use (after route)", {
    command: "passkey_use",
    args: { browserId },
  });
  const answered = await pagePoll(second, "window.__condResult", 3000);
  harness.passkeys.setPaseoBrowserPasskeyChoiceSurface(null);
  passkeyCheck(
    checks,
    "a client-routed 'Sign in' click then autofill within 1 s stays signed out and asks to confirm",
    passkeyProblems([
      [location, "/login-view"],
      [signedIn, null],
      [waiting?.reason, "navigated_after_gesture"],
      [status.tab?.request?.reason, "navigated_after_gesture"],
      [JSON.stringify(surfaceEvents), JSON.stringify(["show navigated_after_gesture 1", "hide"])],
      [used.outcome, "used"],
      [answered?.id, created.id],
    ]),
    { routed, signedIn, waiting, surfaceEvents, used, answered },
  );
}

// A person's click arrives as trusted input; on a guest Electron reports it as input-event.
async function verifyPasskeyTrustedClick({ checks, second, harness, url, created }) {
  await loadPasskeyPage(harness, second, url);
  const rect = await second.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Sign in with a passkey'); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    false,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await second.debugger.sendCommand("Input.dispatchMouseEvent", {
      type,
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
  }
  const clicked = await pagePoll(second, "window.__clickResult", 3000);
  passkeyCheck(
    checks,
    "a trusted click on the passkey button signs in at once (input-event on the guest)",
    passkeyProblems([
      [clicked?.ok, true],
      [clicked?.id, created.id],
      [harness.hub.waitingRequest(second.id), null],
    ]),
    { clicked },
  );
}

async function verifyPasskeyAccountChoice({ checks, second, harness, url, run, browserId }) {
  // The pane surface main.ts wires through ipc.ts, recorded instead of sent to a host window.
  const surfaceEvents = [];
  harness.passkeys.setPaseoBrowserPasskeyChoiceSurface({
    show: (request) => surfaceEvents.push(`show ${request.reason} ${request.accounts.length}`),
    hide: () => surfaceEvents.push("hide"),
  });
  await loadPasskeyPage(harness, second, url);
  const bob = await second.executeJavaScript("__create('bob@example.com')", true);
  const deadline = Date.now() + 3000;
  while (harness.store.list().length < 2 && Date.now() < deadline) await delay(50);
  await passkeyClick(run, browserId, "Sign in with a passkey");
  await delay(1500);
  const pending = await second.executeJavaScript("window.__clickResult ?? null", false);
  const waiting = harness.hub.waitingRequest(second.id);
  const choose = await run("passkey_use (two accounts)", {
    command: "passkey_use",
    args: { browserId },
  });
  const stillPending = await second.executeJavaScript("window.__clickResult ?? null", false);
  const used = await run("passkey_use bob", {
    command: "passkey_use",
    args: { browserId, account: "bob@example.com" },
  });
  const signedIn = await pagePoll(second, "window.__clickResult", 3000);
  const accounts = (choose.request?.accounts ?? []).map((account) => account.account).sort();
  passkeyCheck(
    checks,
    "two stored accounts: a click waits for a choice, the named account signs in",
    passkeyProblems([
      [bob.ok, true],
      [harness.store.list().length, 2],
      [pending, null],
      [waiting?.reason, "choose_account"],
      [choose.outcome, "choose"],
      [JSON.stringify(accounts), JSON.stringify(["al•••@example.com", "bo•••@example.com"])],
      [stillPending, null],
      [used.outcome, "used"],
      [signedIn?.ok, true],
      [signedIn?.id, bob.id],
      [JSON.stringify(surfaceEvents), JSON.stringify(["show choose_account 2", "hide"])],
    ]),
    { waiting, choose, used, signedIn, surfaceEvents },
  );
  harness.passkeys.setPaseoBrowserPasskeyChoiceSurface(null);
  // Back to the one stored account the later checks expect.
  await harness.hub.delete(bob.id);
}

async function verifyPasskeyTool({
  checks,
  second,
  harness,
  page,
  created,
  stored,
  run,
  browserId,
}) {
  const status = await run("passkeys status", {
    command: "passkeys",
    args: { action: "status", browserId },
  });
  passkeyCheck(
    checks,
    "browser_passkeys status reports the tab's site and stored passkey",
    passkeyProblems([
      [status.tab.installed, true],
      [status.tab.host, "localhost"],
      [status.passkeys.length, 1],
      [status.passkeys[0]?.credentialId, created.id],
      [status.storage.encrypted, true],
      [JSON.stringify(status).includes(harness.store.keyOf(stored.credentialId)), false],
    ]),
    status,
  );
  const deleted = await run("passkeys delete", {
    command: "passkeys",
    args: { action: "delete", credentialId: created.id },
  });
  const afterDelete = await page(second, "__get()");
  const listed = await run("passkeys list", { command: "passkeys", args: { action: "list" } });
  passkeyCheck(
    checks,
    "delete revokes the passkey in the store and in the live guest",
    passkeyProblems([
      [deleted.deleted, true],
      [listed.passkeys.length, 0],
      [afterDelete.ok, false],
      [afterDelete.name, "NotAllowedError"],
    ]),
    { deleted, listed, afterDelete },
  );
}

// Daseo delta 110: a card form in a cross-origin iframe. The page is served from 127.0.0.1 and the
// form from localhost, another site, so Chromium runs the form in its own renderer process (an
// out-of-process iframe, as Stripe's form is on a shop's page); a second form on 127.0.0.1 with
// another port is cross-origin but same-site and stays in the page's process.
async function startCrossOriginFramesServers() {
  const listen = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return { server, port: server.address().port };
  };
  const html = (response, body) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  };
  const form = await listen((request, response) => {
    if (request.url === "/tiny") {
      html(response, "<!doctype html><title>Controller</title><button>Hidden control</button>");
      return;
    }
    if (request.url === "/promo") {
      html(
        response,
        `<!doctype html><title>Promo</title>
        <input id="promo" aria-label="Promo code">
        <script>
          window.__log = [];
          document.getElementById('promo').addEventListener('keydown', (event) => {
            window.__log.push({ type: 'keydown', key: event.key, trusted: event.isTrusted });
          });
        </script>`,
      );
      return;
    }
    html(
      response,
      `<!doctype html><title>Card form</title>
      <style>body { margin: 0; font: 14px sans-serif; } input, select, button { display: block; margin: 8px; }</style>
      <input id="card" aria-label="Card number" autocomplete="off">
      <input id="exp" aria-label="Expiration" placeholder="MM / YY">
      <select id="country" aria-label="Country"><option value="">Choose</option><option value="KR">Korea</option><option value="JP">Japan</option></select>
      <button id="save">Save</button>
      <p id="status">Not saved</p>
      <script>
        window.__log = [];
        const log = (entry) => window.__log.push(entry);
        const card = document.getElementById('card');
        const exp = document.getElementById('exp');
        // Formats on every input as a payment form does: groups of four, MM / YY.
        card.addEventListener('input', (event) => {
          log({ type: 'input', field: 'card', trusted: event.isTrusted });
          const digits = card.value.replace(/\\D/g, '').slice(0, 16);
          card.value = digits.replace(/(\\d{4})(?=\\d)/g, '$1 ');
        });
        exp.addEventListener('input', () => {
          const digits = exp.value.replace(/\\D/g, '').slice(0, 4);
          exp.value = digits.length > 2 ? digits.slice(0, 2) + ' / ' + digits.slice(2) : digits;
        });
        for (const field of [card, exp]) {
          field.addEventListener('keydown', (event) => {
            log({ type: 'keydown', field: field.id, key: event.key, trusted: event.isTrusted });
            if (event.key === 'Enter') document.getElementById('status').textContent = 'Submitted ' + card.value;
          });
        }
        const save = document.getElementById('save');
        save.addEventListener('mouseover', (event) => log({ type: 'mouseover', trusted: event.isTrusted }));
        save.addEventListener('click', (event) => {
          log({ type: 'click', trusted: event.isTrusted, x: event.clientX, y: event.clientY });
          document.getElementById('status').textContent = 'Saved ' + card.value;
        });
      </script>`,
    );
  });
  const promo = await listen((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${form.port}/promo` });
    response.end();
  });
  const formOrigin = `http://localhost:${form.port}`;
  const sameSiteOrigin = `http://127.0.0.1:${form.port}`;
  const page = await listen((_request, response) =>
    html(
      response,
      `<!doctype html><title>Checkout</title>
      <style>
        body { margin: 0; }
        iframe { display: block; margin: 20px 0 0 120px; border: 3px solid #888; padding: 5px; }
        #card-frame { width: 480px; height: 260px; }
        #promo-frame { width: 320px; height: 60px; }
        #tiny { width: 1px; height: 1px; border: 0; padding: 0; margin: 0; }
      </style>
      <h1>Checkout</h1>
      <input id="name" aria-label="Name on order">
      <iframe id="card-frame" title="Secure card form" src="${formOrigin}/card"></iframe>
      <iframe id="promo-frame" title="Promo" src="${sameSiteOrigin}/promo"></iframe>
      <iframe id="tiny" title="Controller" src="${formOrigin}/tiny"></iframe>`,
    ),
  );
  return {
    servers: [form.server, promo.server, page.server],
    pageUrl: `http://127.0.0.1:${page.port}/`,
    formOrigin,
  };
}

async function runCrossOriginFramesGroup() {
  const fixture = await startCrossOriginFramesServers();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "cross-origin frames harness window loadFile",
    );
    await waitForInactiveReveal(handle, "cross-origin frames harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: fixture.pageUrl,
    });
    await waitForGuestLoad(guest);
    await delay(500);
    const context = createCrossOriginFramesContext({ win, guest, fixture });
    verifyCrossOriginProcesses(context);
    const refs = await verifyCrossOriginSnapshot(context);
    await verifyCrossOriginFind(context, refs);
    await verifyCrossOriginBackground(context, refs);
    await verifyCrossOriginTrustedPointer(context, refs);
    await verifyCrossOriginReads(context, refs);
    await verifyCrossOriginSameSite(context, refs);
    await verifyCrossOriginRefusals(context, refs);
    return context.results;
  } finally {
    if (!win.isDestroyed()) win.close();
    for (const server of fixture.servers) await closeServer(server);
  }
}

function createCrossOriginFramesContext({ win, guest, fixture }) {
  const context = {
    win,
    guest,
    fixture,
    harness: createFramesAutomation(guest),
    results: [],
    crashed: null,
    frameOf: (urlPart) =>
      guest.mainFrame.framesInSubtree.find((frame) => frame.url.includes(urlPart)),
    inCard: (expression) => context.frameOf("/card").executeJavaScript(expression),
    check(name, problems, detail = {}) {
      if (context.crashed) problems.push(`renderer crashed ${JSON.stringify(context.crashed)}`);
      if (problems.length > 0) fail(`cross-origin-frames ${name}: ${problems.join("; ")}`);
      pass(`cross-origin-frames ${name}`);
      context.results.push({ group: "cross-origin-frames", check: name, pass: true, ...detail });
    },
  };
  guest.on("render-process-gone", (_event, details) => {
    context.crashed = details;
  });
  return context;
}

// The problems among [condition, message] pairs.
function unmet(pairs) {
  return pairs.filter(([condition]) => !condition).map(([, message]) => message);
}

function verifyCrossOriginProcesses({ guest, frameOf, check }) {
  const cardFrame = frameOf("/card");
  const promoFrame = frameOf("/promo");
  const mainProcess = guest.mainFrame.processId;
  check(
    "fixture-processes",
    unmet([
      [cardFrame?.processId !== mainProcess, "the card form is not an out-of-process frame"],
      [promoFrame?.processId === mainProcess, "the promo form is not in the page's process"],
    ]),
  );
}

async function verifyCrossOriginSnapshot({ harness, check }) {
  const { snapshot, stats } = await harness.run("snapshot", {
    command: "snapshot",
    args: { browserId: harness.browserId },
  });
  const refOf = (line) => {
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped} \\[ref=(@(?:f\\d+)?e\\d+)\\]`).exec(snapshot)?.[1] ?? null;
  };
  const refs = {
    name: refOf('textbox "Name on order"'),
    card: refOf('textbox "Card number"'),
    exp: refOf('textbox "Expiration"'),
    country: refOf('combobox "Country"'),
    save: refOf('button "Save"'),
    promo: refOf('textbox "Promo code"'),
  };
  const cardBlock =
    /- iframe "Secure card form" \[cross-origin=true src=[^\]]+\]\n((?: {4}- .*\n?)+)/.exec(
      snapshot,
    )?.[1] ?? "";
  const frameRefs = Object.entries(refs).filter(([key]) => key !== "name");
  check(
    "snapshot",
    unmet([
      [/^@e\d+$/.test(refs.name ?? ""), `main ref ${refs.name}`],
      ...frameRefs.map(([key, ref]) => [/^@f\d+e\d+$/.test(ref ?? ""), `${key} ref ${ref}`]),
      [cardBlock.includes('textbox "Card number"'), "card content not under its iframe"],
      [
        /- iframe "Controller" \[cross-origin=true src=[^\]]+\]\n(?! {4})/.test(`${snapshot}\n`),
        "the 1px frame was walked",
      ],
      [!snapshot.includes("Hidden control"), "the 1px frame's content is listed"],
    ]),
    { refs, nodeCount: stats.nodeCount, textLength: stats.textLength },
  );
  return refs;
}

async function verifyCrossOriginFind({ harness, check }, refs) {
  const found = await harness.run("find", {
    command: "find",
    args: { browserId: harness.browserId, role: "textbox", exact: false, limit: 20 },
  });
  const foundRefs = new Set(found.matches.map((match) => match.ref));
  check(
    "find",
    unmet(
      [refs.name, refs.card, refs.exp, refs.promo].map((ref) => [
        foundRefs.has(ref),
        `find has no ${ref}: ${JSON.stringify(found.matches)}`,
      ]),
    ),
  );
}

// Background (the browser does not hold input focus): events are sent to the element.
async function verifyCrossOriginBackground({ harness, inCard, check }, refs) {
  const { browserId } = harness;
  const run = (label, command, args) =>
    harness.run(label, { command, args: { browserId, ...args } });
  await run("background click", "click", { ref: refs.save });
  const status1 = await inCard("document.getElementById('status').textContent");
  await run("fill", "fill", { ref: refs.card, value: "4111111111111111" });
  const filled = await inCard("document.getElementById('card').value");
  await run("fill clear", "fill", { ref: refs.card, value: "" });
  await run("type card", "type", { ref: refs.card, text: "4242424242424242" });
  const typed = await inCard("document.getElementById('card').value");
  const cardInput = await inCard(
    "window.__log.filter((entry) => entry.type === 'input' && entry.field === 'card').at(-1)",
  );
  await run("keypress Tab", "keypress", { key: "Tab" });
  const afterTab = await inCard("document.activeElement && document.activeElement.id");
  await run("type expiry without ref", "type", { text: "1234" });
  const expiry = await inCard("document.getElementById('exp').value");
  await run("select", "select", { ref: refs.country, value: "KR" });
  const country = await inCard("document.getElementById('country').value");
  await run("keypress Enter", "keypress", { ref: refs.exp, key: "Enter" });
  const status2 = await inCard("document.getElementById('status').textContent");
  const enterKey = await inCard("window.__log.filter((entry) => entry.key === 'Enter').at(-1)");
  check(
    "background-actions",
    unmet([
      [status1 === "Saved ", `click status ${JSON.stringify(status1)}`],
      [filled === "4111 1111 1111 1111", `fill ${JSON.stringify(filled)}`],
      [typed === "4242 4242 4242 4242", `type ${JSON.stringify(typed)}`],
      [cardInput?.trusted === true, `typed input not trusted ${JSON.stringify(cardInput)}`],
      [afterTab === "exp", `Tab left focus on ${JSON.stringify(afterTab)}`],
      [expiry === "12 / 34", `expiry ${JSON.stringify(expiry)}`],
      [country === "KR", `select ${JSON.stringify(country)}`],
      [status2 === "Submitted 4242 4242 4242 4242", `Enter status ${JSON.stringify(status2)}`],
      [enterKey?.trusted === true, `Enter key ${JSON.stringify(enterKey)}`],
    ]),
    { typed, expiry, country },
  );
}

// Trusted input (the browser holds input focus): pointer input lands at tab coordinates. That
// happens only while a person has the pane open, so the surface is shown at full size: Chromium
// routes a mouse event into an out-of-process frame by compositor hit testing, which the parked
// 1x1 surface cannot answer.
async function verifyCrossOriginTrustedPointer({ win, guest, harness, inCard, check }, refs) {
  const { browserId } = harness;
  const setSurface = (width, height) =>
    win.webContents.executeJavaScript(`(() => {
      const host = document.getElementById('paseo-browser-resident-webviews');
      host.style.width = '${width}px';
      host.style.height = '${height}px';
      host.style.pointerEvents = '${width > 1 ? "auto" : "none"}';
      return true;
    })()`);
  await setSurface(1000, 700);
  await delay(400);
  harness.state.inputFocused = true;
  await harness.run("trusted hover", { command: "hover", args: { browserId, ref: refs.save } });
  const trusted = await harness.run("trusted click", {
    command: "click",
    args: { browserId, ref: refs.save },
  });
  harness.state.inputFocused = false;
  await setSurface(1, 1);
  const frameBox = await guest.executeJavaScript(`(() => {
    const frame = document.getElementById('card-frame');
    const rect = frame.getBoundingClientRect();
    return { x: rect.left + frame.clientLeft + 5, y: rect.top + frame.clientTop + 5 };
  })()`);
  const inner = await inCard(`(() => {
    const rect = document.getElementById('save').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const [hover, click] = await inCard(
    "window.__log.filter((entry) => entry.type === 'mouseover' || entry.type === 'click').slice(-2)",
  );
  const offBy = Math.max(
    Math.abs(trusted.x - (frameBox.x + inner.x)),
    Math.abs(trusted.y - (frameBox.y + inner.y)),
  );
  check(
    "trusted-pointer",
    unmet([
      [offBy <= 1, `click point off by ${offBy}: ${JSON.stringify({ trusted, frameBox, inner })}`],
      [hover?.type === "mouseover" && hover.trusted === true, `hover ${JSON.stringify(hover)}`],
      [click?.type === "click" && click.trusted === true, `click ${JSON.stringify(click)}`],
    ]),
    { point: { x: trusted.x, y: trusted.y } },
  );
}

async function verifyCrossOriginReads({ harness, check }, refs) {
  const { browserId } = harness;
  const evaluatedFrame = await harness.run("evaluate frame ref", {
    command: "evaluate",
    args: {
      browserId,
      ref: refs.card,
      function: "(element) => [element.ownerDocument.title, element.value]",
    },
  });
  const evaluatedMain = await harness.run("evaluate main", {
    command: "evaluate",
    args: { browserId, function: "() => document.title" },
  });
  // The trusted click above saved the form.
  const waited = await harness.run("wait text in frame", {
    command: "wait",
    args: { browserId, text: "Saved 4242 4242" },
  });
  const read = await harness.run("read frame ref", {
    command: "read",
    args: { browserId, ref: refs.save },
  });
  check(
    "evaluate-wait-read",
    unmet([
      [
        evaluatedFrame.resultJson === '["Card form","4242 4242 4242 4242"]',
        `frame evaluate ${evaluatedFrame.resultJson}`,
      ],
      [evaluatedMain.resultJson === '"Checkout"', `main evaluate ${evaluatedMain.resultJson}`],
      [waited.matched === "text", `wait ${JSON.stringify(waited)}`],
      [JSON.stringify(read).includes("Save"), `read ${JSON.stringify(read)}`],
    ]),
  );
}

// The same-site frame shares the page's renderer: the tab's own input reaches it.
async function verifyCrossOriginSameSite({ harness, frameOf, check }, refs) {
  const { browserId } = harness;
  await harness.run("type promo", {
    command: "type",
    args: { browserId, ref: refs.promo, text: "SAVE10" },
  });
  await harness.run("keypress promo", {
    command: "keypress",
    args: { browserId, ref: refs.promo, key: "Enter" },
  });
  const promo = await frameOf("/promo").executeJavaScript(
    "({ value: document.getElementById('promo').value, enter: window.__log.filter((entry) => entry.key === 'Enter').length })",
  );
  check(
    "same-site-frame",
    unmet([[promo.value === "SAVE10" && promo.enter === 1, JSON.stringify(promo)]]),
  );
}

async function verifyCrossOriginRefusals({ guest, fixture, harness, check }, refs) {
  const { browserId } = harness;
  const unsupported = await harness.execute({
    command: "styles",
    args: { browserId, ref: refs.card, maxRules: 5 },
  });
  await guest.executeJavaScript(
    `document.getElementById('card-frame').src = '${fixture.formOrigin}/tiny'`,
  );
  await delay(800);
  const stale = await harness.execute({
    command: "fill",
    args: { browserId, ref: refs.card, value: "1" },
  });
  check(
    "refusals",
    unmet([
      [unsupported.error?.code === "browser_unsupported", `styles ${JSON.stringify(unsupported)}`],
      [/stale/.test(JSON.stringify(stale)) && stale.ok === false, `stale ${JSON.stringify(stale)}`],
    ]),
  );
}

async function runPasskeysGroup() {
  const harness = createPasskeyHarnessHub();
  const { server, url } = await startPasskeyServer();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  // The production wiring: bind the picker to the guest session and attach every guest.
  win.webContents.on("did-attach-webview", (_event, contents) => harness.attach(contents));
  const checks = [];
  // A user-gesture page script, marked as a gesture the way the production adapter marks an
  // agent's focus-isolated click (ipc.ts).
  const page = (guest, code) => {
    harness.passkeys.markPaseoBrowserUserGesture(guest.id);
    return guest.executeJavaScript(code, true);
  };
  const openGuest = async () => {
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: url,
    });
    await waitForGuestLoad(guest);
    await harness.hub.settle(guest.id);
    return guest;
  };
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "passkeys harness window loadFile",
    );
    await waitForInactiveReveal(handle, "passkeys harness window");
    const first = await openGuest();
    const { created, stored } = await verifyPasskeyRegistration({ checks, first, harness, page });
    const second = await openGuest();
    await verifyPasskeyReuse({ checks, first, second, harness, page, url, created });
    const browserId = "44444444-4444-4444-8444-444444444444";
    const run = createPasskeyAutomation(second, browserId);
    const context = { checks, second, harness, url, created, run, browserId };
    await verifyPasskeyAutofillWaits(context);
    await verifyPasskeyButton(context);
    await verifyPasskeyAfterClientRoute(context);
    await verifyPasskeyTrustedClick(context);
    await verifyPasskeyAccountChoice(context);
    await verifyPasskeyTool({ checks, second, harness, page, created, stored, run, browserId });
    return checks;
  } finally {
    harness.dispose();
    if (!win.isDestroyed()) win.close();
    await closeServer(server);
  }
}

// Delta 33 tab lifecycle, through the production IPC handler, lifecycle, CDP adapter, and
// automation service against a real parked guest. Unlike the Playwright desktop E2E, nothing here
// enables DevTools focus emulation, which pins a page visible and so unfreezable.
const LIFECYCLE_THROTTLE_MS = 1_500;
const LIFECYCLE_FREEZE_MS = 3_000;
const LIFECYCLE_FROZEN_GAP_MS = 2_000;
// Captures pass through the display color profile, so the page's rgb(42,157,143) comes back near
// rgb(29,148,132); the tolerance accepts that shift and still rejects a blank or stale frame.
const LIFECYCLE_PAGE_RGB = [42, 157, 143];

async function startLifecycleServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>Lifecycle target</title></head>
      <body style="margin:0;min-height:100vh;background:rgb(42,157,143)">
        <button id="lifecycle-target" onclick="window.__clicks++">Lifecycle target</button>
        <script>
          window.__clicks = 0;
          window.__lastTickAt = Date.now();
          window.__maxTickGapMs = 0;
          setInterval(() => {
            const now = Date.now();
            window.__maxTickGapMs = Math.max(window.__maxTickGapMs, now - window.__lastTickAt);
            window.__lastTickAt = now;
          }, 50);
        </script>
      </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function runTabLifecycleGroup() {
  process.env.PASEO_BROWSER_TAB_LIFECYCLE_MS = `${LIFECYCLE_THROTTLE_MS},${LIFECYCLE_FREEZE_MS}`;
  const webviews = require(path.join(DIST_DIR, "features", "browser-webviews", "index.js"));
  const { registerBrowserAutomationIpc } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const handlers = new Map();
  registerBrowserAutomationIpc({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  const lifecycle = webviews.getPaseoBrowserTabLifecycle();
  const target = await startLifecycleServer();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win);
  const browserId = "44444444-4444-4444-8444-444444444444";
  const workspaceId = "lifecycle-harness-workspace";
  const frames = [];
  const host = {
    id: win.webContents.id,
    isDestroyed: () => false,
    once: () => {},
    send: (channel, frame) => {
      if (channel === "paseo:browser:stream-frame") frames.push(frame);
    },
  };
  let requestCounter = 0;
  const execute = async (command) => {
    const payload = await handlers.get("paseo:browser:execute-automation-command")(
      { sender: host },
      {
        type: "browser.automation.execute.request",
        requestId: `lifecycle-${(requestCounter += 1)}`,
        workspaceId,
        command,
      },
    );
    if (!payload.ok) fail(`${command.command} failed: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };
  const readPage = async () => {
    const result = await execute({
      command: "evaluate",
      args: {
        browserId,
        function:
          "() => { const s = { clicks: window.__clicks, gap: window.__maxTickGapMs }; window.__maxTickGapMs = 0; return s; }",
      },
    });
    return JSON.parse(result.resultJson);
  };
  const waitFrozen = async (label) => {
    const deadline = Date.now() + LIFECYCLE_FREEZE_MS + 5_000;
    while (lifecycle.getState(guest.id) !== "frozen") {
      if (Date.now() > deadline) fail(`${label}: tab never reached frozen`);
      await delay(100);
    }
    await delay(LIFECYCLE_FROZEN_GAP_MS + 500);
  };
  const timed = async (task) => {
    const startedAt = Date.now();
    const result = await task();
    return { result, ms: Date.now() - startedAt };
  };
  let guest;
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "lifecycle harness window loadFile",
    );
    await waitForInactiveReveal(handle, "lifecycle harness window");
    ({ guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: target.url,
    }));
    webviews.preparePaseoBrowserWebContents(guest);
    webviews.registerManagedPaseoBrowserTarget({
      browserId,
      workspaceId,
      webContentsId: guest.id,
      hostWebContentsId: win.webContents.id,
      metadata: { kind: "tab" },
    });
    await waitForGuestLoad(guest);
    const snapshot = await execute({ command: "snapshot", args: { browserId } });
    const ref = snapshot.snapshot.match(
      /button "Lifecycle target" \[(?:[^\]]* )?ref=(@e\d+)\]/,
    )?.[1];
    if (!ref) fail(`lifecycle fixture button missing: ${snapshot.snapshot}`);

    const warm = await timed(() => execute({ command: "click", args: { browserId, ref } }));
    await readPage();
    await waitFrozen("click");
    const frozenClick = await timed(() => execute({ command: "click", args: { browserId, ref } }));
    const afterClick = await readPage();
    if (afterClick.gap < LIFECYCLE_FROZEN_GAP_MS)
      fail(`page kept running while frozen: ${JSON.stringify(afterClick)}`);
    if (afterClick.clicks !== 2)
      fail(`click on a woken tab was lost: ${JSON.stringify(afterClick)}`);
    if (frozenClick.ms - warm.ms >= 500)
      fail(`waking added ${frozenClick.ms - warm.ms}ms to click`);
    pass(
      `tab-lifecycle click after freeze: warm=${warm.ms}ms frozen=${frozenClick.ms}ms pageGap=${afterClick.gap}ms`,
    );

    await waitFrozen("screenshot");
    const shot = await timed(() => execute({ command: "screenshot", args: { browserId } }));
    const image = nativeImage.createFromBuffer(Buffer.from(shot.result.dataBase64, "base64"));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
    const [b, g, r] = bitmap.subarray(offset, offset + 3);
    const afterShot = await readPage();
    if (afterShot.gap < LIFECYCLE_FROZEN_GAP_MS)
      fail(`page kept running before screenshot: ${JSON.stringify(afterShot)}`);
    if ([r, g, b].some((value, index) => Math.abs(value - LIFECYCLE_PAGE_RGB[index]) > 24)) {
      fail(`screenshot of a woken tab is not the page: rgb(${r},${g},${b})`);
    }
    pass(
      `tab-lifecycle screenshot after freeze: ${shot.ms}ms ${size.width}x${size.height} center=rgb(${r},${g},${b}) pageGap=${afterShot.gap}ms`,
    );

    await waitFrozen("stream");
    const streamStarted = Date.now();
    await execute({ command: "stream_start", args: { browserId, quality: 40 } });
    while (frames.length === 0 && Date.now() - streamStarted < 5_000) await delay(50);
    const firstFrameMs = Date.now() - streamStarted;
    await execute({ command: "stream_stop", args: { browserId } });
    const afterStream = await readPage();
    if (afterStream.gap < LIFECYCLE_FROZEN_GAP_MS)
      fail(`page kept running before stream: ${JSON.stringify(afterStream)}`);
    if (frames.length === 0) fail("phone stream of a woken tab sent no frame");
    pass(
      `tab-lifecycle stream after freeze: first frame ${firstFrameMs}ms pageGap=${afterStream.gap}ms`,
    );
    return [
      {
        group: "tab-lifecycle",
        check: "click",
        warmMs: warm.ms,
        frozenMs: frozenClick.ms,
        pageGapMs: afterClick.gap,
        pass: true,
      },
      {
        group: "tab-lifecycle",
        check: "screenshot",
        ms: shot.ms,
        center: [r, g, b],
        pageGapMs: afterShot.gap,
        pass: true,
      },
      {
        group: "tab-lifecycle",
        check: "stream",
        firstFrameMs,
        pageGapMs: afterStream.gap,
        pass: true,
      },
    ];
  } finally {
    if (!win.isDestroyed()) win.close();
    await closeServer(target.server);
  }
}

// Real-Chromium checks for the debugging tools (delta 35): evaluate under CSP and
// Trusted Types, console navigation marks and level, matched CSS with sources,
// scoped snapshots, element screenshots, and device emulation.
async function startDebuggingServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/app.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(
        [
          "body { margin: 0; font-family: sans-serif; }",
          ".card .title { font-size: 18px; color: blue; }",
          "@media (max-width: 500px) { .title { letter-spacing: 1px; } }",
          ".card button { color: blue; }",
          "#buy { color: green; }",
        ].join("\n"),
      );
      return;
    }
    if (request.url === "/ua") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>UA</title><meta name="viewport" content="width=device-width"><p id="ua">${String(
          request.headers["user-agent"] ?? "",
        ).replace(/</g, "&lt;")}</p>`,
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "script-src 'self' 'nonce-n1'; require-trusted-types-for 'script'",
    });
    response.end(`<!doctype html><title>Debug fixture</title>
      <link rel="stylesheet" href="/app.css">
      <style>.title { color: red; font-weight: 700; }</style>
      <nav aria-label="Main"><div><span>Menu</span><button>Open cart</button></div></nav>
      <div class="card"><h2 class="title" style="color: purple">Card title</h2>
        <button id="buy" style="width: 120px; height: 40px; color: purple">Buy now</button></div>
      <p>Long text that interactive snapshots leave out.</p>
      <script nonce="n1">console.error("fixture loaded " + location.search);</script>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Delta 93: page dialogs never open a native message box. Electron's own dialog listener calls
// dialog.showMessageBox, so the group replaces that function with a recorder for its whole run:
// any call is a failure, and the recorder answers at once so nothing ever waits on screen.
async function startDialogsServer() {
  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.startsWith("/idle")) {
      response.end(`<!doctype html><title>Idle dialogs</title><p>idle</p><script>
        window.r = {};
        setTimeout(() => {
          r.alert = alert("idle alert");
          r.confirm = confirm("idle confirm");
          try { r.prompt = prompt("idle prompt", "d"); } catch (error) { r.promptThrew = String(error); }
          r.done = true;
        }, 200);
      </script>`);
      return;
    }
    if (url.startsWith("/opener")) {
      response.end(
        '<!doctype html><title>Opener</title><script>window.popup = window.open("/idle", "dialogs-popup", "width=400,height=300")</script>',
      );
      return;
    }
    if (url.startsWith("/save")) {
      response.end(`<!doctype html><title>Save</title>
        <button id="save" onclick="if (confirm('저장하시겠습니까?')) { window.saved = (window.saved || 0) + 1; }">Save</button>
        <button id="name" onclick="window.named = prompt('name?', 'def')">Name</button>
        <button id="chain" onclick="if (confirm('Delete?')) { alert('Deleted'); window.deleted = true; }">Chain</button>`);
      return;
    }
    if (url.startsWith("/leave")) {
      response.end(`<!doctype html><title>Leave</title><input id="field" style="width:400px;height:60px">
        <script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; });</script>`);
      return;
    }
    if (url.startsWith("/notify")) {
      response.end("<!doctype html><title>Notify</title><p>notify</p>");
      return;
    }
    response.end("<!doctype html><title>Blank</title><p>blank</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function dialogsCheck(checks, name, problems, detail) {
  if (problems.length > 0) {
    fail(`dialogs ${name} (${problems.join("; ")}): ${JSON.stringify(detail)}`);
  }
  pass(`dialogs ${name}`);
  checks.push({ group: "dialogs", check: name, pass: true, detail });
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await delay(25);
  }
}

async function runDialogsGroup() {
  const target = await startDialogsServer();
  const { getPaseoBrowserPageDialogs, isPaseoBrowserPageDialogHookMissing } = require(
    path.join(PRODUCTION_BROWSER_AUTOMATION_DIR, "page-dialog-hook.js"),
  );
  const { preparePaseoBrowserPageDialogs } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const { installPaseoBrowserPermissionPolicy } = require(
    path.join(DIST_DIR, "features", "browser-profile.js"),
  );
  const nativeBoxes = [];
  const realShowMessageBox = electronDialog.showMessageBox;
  const realShowMessageBoxSync = electronDialog.showMessageBoxSync;
  electronDialog.showMessageBox = (...args) => {
    const options = args.length > 1 ? args[1] : args[0];
    nativeBoxes.push({ message: options?.message, parented: args.length > 1 });
    return Promise.resolve({ response: 0, checkboxChecked: false });
  };
  electronDialog.showMessageBoxSync = (...args) => {
    const options = args.length > 1 ? args[1] : args[0];
    nativeBoxes.push({ message: options?.message, sync: true });
    return 0;
  };
  // What main.ts does on web-contents-created for the browser profile: every guest and popup gets
  // its dialogs owned (and prompt restored) from the moment it exists.
  const popups = [];
  const onCreated = (_event, contents) => {
    if (contents.session === session.defaultSession) return;
    preparePaseoBrowserPageDialogs(contents);
    if (contents.getType() === "window") popups.push(contents);
  };
  app.on("web-contents-created", onCreated);
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  let sheets = 0;
  win.on("sheet-begin", () => {
    sheets += 1;
  });
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  const checks = [];
  const extraWindows = [];
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "dialogs harness window loadFile",
    );
    await waitForInactiveReveal(handle, "dialogs harness window");

    await verifyIdleTabDialogs({
      checks,
      win,
      tracker,
      target,
      nativeBoxes,
      getSheets: () => sheets,
      getPaseoBrowserPageDialogs,
      isPaseoBrowserPageDialogHookMissing,
    });
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${target.origin}/blank`,
    });
    await waitForGuestLoad(guest);
    // Popups stay hidden windows here, as Daseo adopts them into views.
    guest.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: { show: false },
    }));
    await verifyPopupDialogs({ checks, guest, popups, target, nativeBoxes, extraWindows });
    const harness = createFramesAutomation(guest);
    await verifyAgentConfirmFlow({ checks, harness, guest, target });
    await verifyAgentPromptFlow({ checks, harness, guest, target });
    await verifyHeldDialogBlocksPageTools({ checks, harness, guest, target });
    await verifyBeforeUnloadLeave({ checks, harness, guest, target });
    await verifyNotificationsDenied({ checks, guest, target, installPaseoBrowserPermissionPolicy });
    await verifyDisableDialogsFallback({ checks, target, nativeBoxes, extraWindows });
    if (process.env.PASEO_CAPTURE_HARNESS_SKIP_UNANSWERED !== "1") {
      await verifyUnansweredDismissal({ checks, harness, guest, target });
    }
    dialogsCheck(
      checks,
      "no page dialog opened a native message box or a sheet on the window, and the window still answers",
      failedChecks({
        noNativeBox: nativeBoxes.length === 0,
        noSheet: sheets === 0,
        windowAnswers:
          (await withTimeout(renderer(win, "1 + 1"), "host renderer answers", 2000)) === 2,
      }),
      { nativeBoxes, sheets },
    );
    return checks;
  } finally {
    app.removeListener("web-contents-created", onCreated);
    electronDialog.showMessageBox = realShowMessageBox;
    electronDialog.showMessageBoxSync = realShowMessageBoxSync;
    for (const extra of extraWindows) if (!extra.isDestroyed()) extra.destroy();
    for (const popup of popups) if (!popup.isDestroyed()) popup.close();
    if (!win.isDestroyed()) win.close();
    await closeServer(target.server);
  }
}

// Criterion 1, root tab: no command, nobody automating. No pane in the harness, so the policy
// answers (alert OK, confirm Cancel, prompt Cancel) and records them; nothing native.
async function verifyIdleTabDialogs(input) {
  const { checks, win, tracker, target, nativeBoxes, getSheets } = input;
  const { guest } = await appendPermanentWebview({
    win,
    tracker,
    state: { id: "p1-overflow-1x1" },
    sourceUrl: `${target.origin}/idle`,
  });
  await waitForGuestLoad(guest);
  const result = await waitFor(
    () => guest.mainFrame.executeJavaScript("window.r && window.r.done ? window.r : null", false),
    "idle tab dialogs",
  );
  const recorded = input.getPaseoBrowserPageDialogs(guest.id)?.takePending() ?? [];
  dialogsCheck(
    checks,
    "an idle root tab's alert, confirm, and prompt are answered by Daseo with no native box",
    failedChecks({
      hookInstalled: !input.isPaseoBrowserPageDialogHookMissing(guest.id),
      alertReturned: result.alert === undefined || result.alert === null,
      confirmCancelled: result.confirm === false,
      promptReachesDaseo: result.prompt === null && result.promptThrew === undefined,
      recorded:
        recorded.map((event) => `${event.action} ${event.type}`).join(",") ===
        "accepted alert,dismissed confirm,dismissed prompt",
      noNativeBox: nativeBoxes.length === 0,
      noSheet: getSheets() === 0,
    }),
    { result, recorded, nativeBoxes },
  );
}

// Criterion 1, popup: a window.open popup of the browser profile, no command.
async function verifyPopupDialogs({ checks, guest, popups, target, nativeBoxes }) {
  const before = popups.length;
  await guest.loadURL(`${target.origin}/opener`);
  const popup = await waitFor(() => popups[before] ?? null, "popup created");
  await waitFor(() => !popup.isLoading() && popup.getURL().includes("/idle"), "popup loaded");
  const result = await waitFor(
    () => popup.mainFrame.executeJavaScript("window.r && window.r.done ? window.r : null", false),
    "popup dialogs",
  );
  dialogsCheck(
    checks,
    "a popup's alert, confirm, and prompt are answered by Daseo with no native box",
    failedChecks({
      confirmCancelled: result.confirm === false,
      promptReachesDaseo: result.prompt === null && result.promptThrew === undefined,
      noNativeBox: nativeBoxes.length === 0,
    }),
    { result, nativeBoxes },
  );
  popup.close();
  await guest.loadURL(`${target.origin}/blank`);
}

function refFor(snapshotResult, role, name) {
  const pattern = new RegExp(`${role} "${name}" \\[ref=(@e\\d+)\\]`);
  const ref = snapshotResult?.result?.snapshot?.match(pattern)?.[1];
  if (!ref) fail(`no ref for ${role} "${name}" in ${JSON.stringify(snapshotResult)}`);
  return ref;
}

async function snapshotRefs(harness, names) {
  const snapshot = await harness.execute({
    command: "snapshot",
    args: { browserId: harness.browserId },
  });
  return Object.fromEntries(names.map((name) => [name, refFor(snapshot, "button", name)]));
}

async function timedCall(task) {
  const started = Date.now();
  const value = await task();
  return { value, ms: Date.now() - started };
}

// Criterion 2: confirm held → handle_dialog true / false; pre-armed click in one call; a confirm
// followed by an alert.
async function verifyAgentConfirmFlow({ checks, harness, guest, target }) {
  const { browserId } = harness;
  await harness.run("navigate to the save page", {
    command: "navigate",
    args: { browserId, url: `${target.origin}/save` },
  });
  const refs = await snapshotRefs(harness, ["Save", "Chain"]);
  const saved = () => guest.mainFrame.executeJavaScript("window.saved || 0", false);

  const click = await timedCall(() =>
    harness.execute({ command: "click", args: { browserId, ref: refs.Save } }),
  );
  const accepted = await harness.execute({
    command: "handle_dialog",
    args: { browserId, accept: true },
  });
  const savedAfterAccept = await saved();
  const secondClick = await harness.execute({
    command: "click",
    args: { browserId, ref: refs.Save },
  });
  const dismissed = await harness.execute({
    command: "handle_dialog",
    args: { browserId, accept: false },
  });
  const savedAfterDismiss = await saved();
  const preArmed = await harness.execute({
    command: "click",
    args: { browserId, ref: refs.Save, dialog: "accept" },
  });
  const savedAfterPreArm = await saved();
  dialogsCheck(
    checks,
    "a click's confirm is reported within a second, accept runs the page's save, Cancel does not, and dialog:accept does it in one call",
    failedChecks({
      clickOk: click.value.ok === true,
      clickFast: click.ms < 1500,
      reportedOpen:
        click.value.openDialog?.type === "confirm" &&
        click.value.openDialog?.message === "저장하시겠습니까?",
      acceptedOk: accepted.ok && accepted.result.answered.action === "accepted",
      savedOnAccept: savedAfterAccept === 1,
      secondHeld: secondClick.openDialog?.type === "confirm",
      dismissedOk: dismissed.ok && dismissed.result.answered.action === "dismissed",
      notSavedOnCancel: savedAfterDismiss === 1,
      preArmedOneCall:
        preArmed.ok &&
        preArmed.openDialog === undefined &&
        preArmed.dialogs?.some((event) => event.type === "confirm" && event.action === "accepted"),
      savedOnPreArm: savedAfterPreArm === 2,
    }),
    {
      click,
      accepted,
      secondClick,
      dismissed,
      preArmed,
      savedAfterAccept,
      savedAfterDismiss,
      savedAfterPreArm,
    },
  );

  const chain = await harness.execute({ command: "click", args: { browserId, ref: refs.Chain } });
  const chainAnswered = await harness.execute({
    command: "handle_dialog",
    args: { browserId, accept: true },
  });
  dialogsCheck(
    checks,
    "the alert a page shows after an accepted confirm comes back with the answer",
    failedChecks({
      held: chain.openDialog?.message === "Delete?",
      followUp:
        chainAnswered.ok &&
        chainAnswered.dialogs?.some(
          (event) => event.type === "alert" && event.message === "Deleted",
        ),
      pageRanOn:
        (await guest.mainFrame.executeJavaScript("window.deleted === true", false)) === true,
    }),
    { chain, chainAnswered },
  );
}

// Criterion 2: prompt text reaches the page, through handle_dialog and through dialog:accept.
async function verifyAgentPromptFlow({ checks, harness, guest }) {
  const { browserId } = harness;
  const refs = await snapshotRefs(harness, ["Name"]);
  const held = await harness.execute({ command: "click", args: { browserId, ref: refs.Name } });
  const answered = await harness.execute({
    command: "handle_dialog",
    args: { browserId, accept: true, promptText: "x" },
  });
  const named = await guest.mainFrame.executeJavaScript("window.named", false);
  const preArmed = await harness.execute({
    command: "click",
    args: { browserId, ref: refs.Name, dialog: "accept", promptText: "y" },
  });
  const namedPreArmed = await guest.mainFrame.executeJavaScript("window.named", false);
  dialogsCheck(
    checks,
    "prompt('name?') answered with promptText returns that text to the page",
    failedChecks({
      heldPrompt: held.openDialog?.type === "prompt" && held.openDialog?.defaultValue === "def",
      answered: answered.ok && answered.result.answered.promptText === "x",
      pageGotX: named === "x",
      preArmedOk: preArmed.ok && preArmed.openDialog === undefined,
      pageGotY: namedPreArmed === "y",
    }),
    { held, answered, named, preArmed, namedPreArmed },
  );
}

// Criterion 3: while a confirm is held, snapshot answers at once; navigate still works and clears it.
async function verifyHeldDialogBlocksPageTools({ checks, harness, guest, target }) {
  const { browserId } = harness;
  const refs = await snapshotRefs(harness, ["Save"]);
  await harness.execute({ command: "click", args: { browserId, ref: refs.Save } });
  const snapshot = await timedCall(() =>
    harness.execute({ command: "snapshot", args: { browserId } }),
  );
  const navigated = await timedCall(() =>
    harness.execute({ command: "navigate", args: { browserId, url: `${target.origin}/blank` } }),
  );
  dialogsCheck(
    checks,
    "a held confirm makes snapshot say so at once, and navigate still runs and clears it",
    failedChecks({
      snapshotRefused:
        snapshot.value.ok === false &&
        snapshot.value.error.code === "browser_denied" &&
        snapshot.value.openDialog?.type === "confirm",
      snapshotFast: snapshot.ms < 1000,
      navigated: navigated.value.ok === true && guest.getURL().endsWith("/blank"),
      navigateFast: navigated.ms < 8000,
      dismissedForNavigation: navigated.value.dialogs?.some(
        (event) => event.type === "confirm" && event.reason === "page_left",
      ),
    }),
    { snapshot, navigated },
  );
}

// Criterion 5: an agent navigating away from a page with a live beforeunload handler (the page
// got a trusted input first, so Chromium asks) leaves it and reports it.
async function verifyBeforeUnloadLeave({ checks, harness, guest, target }) {
  const { browserId } = harness;
  await harness.run("navigate to the leave page", {
    command: "navigate",
    args: { browserId, url: `${target.origin}/leave` },
  });
  // The agent's own click (a background tab gets the page-local user-gesture click) gives the page
  // the sticky activation Chromium requires before it asks about beforeunload.
  const snapshot = await harness.execute({ command: "snapshot", args: { browserId } });
  const fieldRef =
    snapshot.result?.snapshot?.match(/textbox \[ref=(@e\d+)\]/)?.[1] ??
    snapshot.result?.snapshot?.match(/textbox "[^"]*" \[ref=(@e\d+)\]/)?.[1];
  if (!fieldRef) fail(`no textbox ref on the leave page: ${JSON.stringify(snapshot)}`);
  await harness.run("click the field", { command: "click", args: { browserId, ref: fieldRef } });
  await delay(100);
  const activated = await guest.mainFrame.executeJavaScript(
    "navigator.userActivation.hasBeenActive",
    false,
  );
  const navigated = await timedCall(() =>
    harness.execute({ command: "navigate", args: { browserId, url: `${target.origin}/blank` } }),
  );
  dialogsCheck(
    checks,
    "an agent's navigate leaves a page whose beforeunload handler asks to stay, and says so",
    failedChecks({
      pageActivated: activated === true,
      navigated: navigated.value.ok === true && guest.getURL().endsWith("/blank"),
      reported: navigated.value.dialogs?.some(
        (event) => event.type === "beforeunload" && event.action === "accepted",
      ),
    }),
    { activated, navigated },
  );
}

// Criterion 7: notifications are denied for the browser profile (the policy main.ts installs).
async function verifyNotificationsDenied({
  checks,
  guest,
  target,
  installPaseoBrowserPermissionPolicy,
}) {
  installPaseoBrowserPermissionPolicy({ fromPartition: () => guest.session });
  await guest.loadURL(`${target.origin}/notify`);
  const state = await guest.mainFrame.executeJavaScript(
    `(async () => ({
      permission: Notification.permission,
      requested: await Notification.requestPermission(),
      query: (await navigator.permissions.query({ name: "notifications" })).state,
      clipboardWrite: (await navigator.permissions.query({ name: "clipboard-write" })).state,
    }))()`,
    true,
  );
  dialogsCheck(
    checks,
    "Notification.permission is denied in the browser profile; other permissions are unchanged",
    failedChecks({
      permission: state.permission === "denied",
      requested: state.requested === "denied",
      query: state.query === "denied",
      clipboardWriteGranted: state.clipboardWrite === "granted",
    }),
    state,
  );
}

// The fallback when Electron drops -run-dialog: disableDialogs (set by main.ts on every browser
// webview and popup) keeps Electron's own listener from showing a box.
async function verifyDisableDialogsFallback({ checks, target, nativeBoxes, extraWindows }) {
  const before = nativeBoxes.length;
  const fallback = new BrowserWindow({
    show: false,
    webPreferences: { partition: "paseo-dialogs-fallback", disableDialogs: true, sandbox: true },
  });
  extraWindows.push(fallback);
  const contents = fallback.webContents;
  await contents.loadURL(`${target.origin}/idle`);
  const result = await waitFor(
    () =>
      contents.mainFrame.executeJavaScript("window.r && window.r.done ? window.r : null", false),
    "fallback dialogs",
  );
  dialogsCheck(
    checks,
    "with disableDialogs and no Daseo hook, Electron answers without a native box",
    failedChecks({
      noNativeBox: nativeBoxes.length === before,
      confirmCancelled: result.confirm === false,
      electronListenerStillThere: contents.listenerCount("-run-dialog") === 1,
    }),
    { result },
  );
  fallback.destroy();
}

// Criterion 4: a held confirm nobody answers is dismissed after 60 s and the next result says so.
async function verifyUnansweredDismissal({ checks, harness, guest, target }) {
  const { browserId } = harness;
  await harness.run("navigate to the save page", {
    command: "navigate",
    args: { browserId, url: `${target.origin}/save` },
  });
  const refs = await snapshotRefs(harness, ["Save"]);
  const savedBefore = await guest.mainFrame.executeJavaScript("window.saved || 0", false);
  const held = await harness.execute({ command: "click", args: { browserId, ref: refs.Save } });
  const expiresIn = (held.openDialog?.expiresAt ?? 0) - Date.now();
  await delay(61_000);
  const next = await harness.execute({ command: "snapshot", args: { browserId } });
  dialogsCheck(
    checks,
    "a held confirm nobody answers is dismissed after 60 s and reported on the next result",
    failedChecks({
      held: held.openDialog?.type === "confirm",
      deadlineAbout60s: expiresIn > 58_000 && expiresIn <= 60_000,
      nextOk: next.ok === true,
      reported: next.dialogs?.some(
        (event) =>
          event.type === "confirm" && event.action === "dismissed" && event.reason === "unanswered",
      ),
      notSaved:
        (await guest.mainFrame.executeJavaScript("window.saved || 0", false)) === savedBefore,
    }),
    { held, next },
  );
}

// Delta 92: a page that never finishes loading still answers; a JS dialog during a load is
// answered and reported; a download an agent starts lands in the Daseo folder without a dialog and
// browser_wait download returns it; a busy page is named instead of waited on; a crash is recorded.
async function startDelta92Server() {
  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/never") return; // held open: the page never finishes loading
    if (url === "/file.csv") {
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="delta92.csv"',
      });
      response.end("a,b\n1,2\n");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.startsWith("/hang-load")) {
      response.end(
        '<!doctype html><title>Hanging load</title><h1 id="t">ready text</h1><img src="/never">',
      );
      return;
    }
    if (url.startsWith("/alert-on-load")) {
      response.end(
        '<!doctype html><title>Alert on load</title><script>alert("Welcome from load")</script><p>after alert</p>',
      );
      return;
    }
    if (url.startsWith("/download")) {
      response.end(
        '<!doctype html><title>Download</title><a id="dl" href="/file.csv">Get the file</a>',
      );
      return;
    }
    if (url.startsWith("/busy")) {
      response.end(
        "<!doctype html><title>Busy</title><p>busy soon</p><script>setTimeout(() => { const end = Date.now() + 60000; while (Date.now() < end) {} }, 300)</script>",
      );
      return;
    }
    response.end("<!doctype html><title>Blank</title><p>blank</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runDelta92Group() {
  const target = await startDelta92Server();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-delta92-downloads-"));
  const { AgentDownloads, setPaseoBrowserAgentDownloads } = require(
    path.join(PRODUCTION_BROWSER_AUTOMATION_DIR, "downloads.js"),
  );
  const downloads = new AgentDownloads({ directory: () => downloadDir });
  setPaseoBrowserAgentDownloads(downloads);
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  const checks = [];
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "delta92 harness window loadFile",
    );
    await waitForInactiveReveal(handle, "delta92 harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${target.origin}/blank`,
    });
    await waitForGuestLoad(guest);
    routeDelta92Downloads(guest, downloads);
    const harness = createFramesAutomation(guest);
    await verifyDelta92StillLoading({ checks, harness, guest, origin: target.origin });
    await verifyDelta92DialogDuringLoad({ checks, harness, guest, origin: target.origin });
    await verifyDelta92Download({ checks, harness, origin: target.origin, downloadDir });
    const { guest: busyGuest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${target.origin}/busy`,
    });
    await waitForGuestLoad(busyGuest);
    await delay(800);
    await verifyDelta92BusyAndCrash({ checks, busyGuest });
    return checks;
  } finally {
    setPaseoBrowserAgentDownloads(null);
    if (!win.isDestroyed()) win.close();
    await closeServer(target.server);
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

function delta92Check(checks, name, problems, detail) {
  if (problems.length > 0) {
    fail(`delta92 ${name} (${problems.join("; ")}): ${JSON.stringify(detail)}`);
  }
  pass(`delta92 ${name}`);
  checks.push({ group: "delta92", check: name, pass: true });
}

function routeDelta92Downloads(guest, downloads) {
  const { wasPaseoBrowserAgentDriven } = require(
    path.join(PRODUCTION_BROWSER_AUTOMATION_DIR, "activity.js"),
  );
  guest.session.on("will-download", (_event, item, contents) => {
    if (contents && wasPaseoBrowserAgentDriven(contents.id)) {
      downloads.handle({ item, contentsIds: [contents.id], browserId: null });
    } else {
      // Never let the harness open a save dialog.
      item.cancel();
    }
  });
}

// Item 4: a load that never finishes.
async function verifyDelta92StillLoading({ checks, harness, guest, origin }) {
  const { browserId } = harness;
  guest.loadURL(`${origin}/hang-load`).catch(() => {});
  await withTimeout(
    new Promise((resolve) => guest.once("dom-ready", resolve)),
    "hang-load dom-ready",
    10000,
  );
  const started = Date.now();
  const snapshot = await withTimeout(
    harness.execute({ command: "snapshot", args: { browserId } }),
    "snapshot of a still-loading page",
    10000,
  );
  const evaluated = await withTimeout(
    harness.execute({
      command: "evaluate",
      args: { browserId, function: "() => document.getElementById('t').textContent" },
    }),
    "evaluate on a still-loading page",
    10000,
  );
  delta92Check(
    checks,
    "a page whose load never finishes still answers snapshot and evaluate, marked loading",
    failedChecks({
      stillLoading: guest.isLoading(),
      snapshotOk: snapshot.ok && snapshot.result.snapshot.includes("ready text"),
      snapshotLoading: snapshot.ok && snapshot.result.loading === true,
      fast: Date.now() - started < 5000,
      evaluateOk: evaluated.ok && evaluated.result.resultJson === '"ready text"',
    }),
    { snapshot, evaluated, ms: Date.now() - started },
  );
}

// Item 9: a dialog during a navigation's load. The hanging load is stopped first: Electron rejects
// a loadURL issued while another load is still running with that load's abort.
async function verifyDelta92DialogDuringLoad({ checks, harness, guest, origin }) {
  guest.stop();
  const stopDeadline = Date.now() + 3000;
  while (guest.isLoading() && Date.now() < stopDeadline) await delay(20);
  const started = Date.now();
  const navigated = await withTimeout(
    harness.execute({
      command: "navigate",
      args: { browserId: harness.browserId, url: `${origin}/alert-on-load` },
    }),
    "navigate to a page that alerts while it loads",
    12000,
  );
  const dialogs = Array.isArray(navigated.dialogs) ? navigated.dialogs : [];
  delta92Check(
    checks,
    "a dialog a page opens while it loads is answered and reported, and the navigation returns",
    failedChecks({
      ok: navigated.ok,
      dialog: dialogs.some(
        (dialog) => dialog.type === "alert" && dialog.message === "Welcome from load",
      ),
      fast: Date.now() - started < 8000,
    }),
    { navigated, ms: Date.now() - started },
  );
}

// Item 7: a download the agent starts.
async function verifyDelta92Download({ checks, harness, origin, downloadDir }) {
  const { browserId } = harness;
  await harness.run("navigate to the download page", {
    command: "navigate",
    args: { browserId, url: `${origin}/download` },
  });
  await harness.run("click the download link", {
    command: "evaluate",
    args: { browserId, function: "() => { document.getElementById('dl').click(); return true; }" },
  });
  const waited = await withTimeout(
    harness.execute({ command: "wait", args: { browserId, download: true, timeoutMs: 10000 } }),
    "browser_wait download",
    15000,
  );
  const savedPath = waited.ok ? waited.result.download?.path : undefined;
  const saved = savedPath && fs.existsSync(savedPath) ? fs.readFileSync(savedPath, "utf8") : null;
  delta92Check(
    checks,
    "an agent's download lands in the Daseo folder without a dialog and browser_wait download returns it",
    failedChecks({
      ok: waited.ok && waited.result.matched === "download",
      inFolder: Boolean(savedPath) && path.dirname(savedPath) === downloadDir,
      name: Boolean(savedPath) && path.basename(savedPath) === "delta92.csv",
      content: saved === "a,b\n1,2\n",
    }),
    { waited, saved },
  );
}

// Item 6: a busy page, then a crash.
async function verifyDelta92BusyAndCrash({ checks, busyGuest }) {
  const { getPaseoBrowserRendererHealth } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const busy = createFramesAutomation(busyGuest);
  const health = getPaseoBrowserRendererHealth();
  const busyGuestId = busyGuest.id;
  // The check the IPC handler runs before every tab command (after the wake).
  const precheckStarted = Date.now();
  const precheck = await withTimeout(
    health.blockingHealth(busyGuestId),
    "check before a command on a busy page",
    8000,
  );
  delta92Check(
    checks,
    "the check before a command reports a busy page in about 3 seconds",
    failedChecks({
      marked: precheck?.state === "not_responding",
      fast: Date.now() - precheckStarted < 4000,
    }),
    { precheck, ms: Date.now() - precheckStarted },
  );
  const started = Date.now();
  const result = await withTimeout(
    busy.execute({ command: "snapshot", args: { browserId: busy.browserId } }),
    "snapshot of a busy page",
    12000,
  );
  delta92Check(
    checks,
    "a command that reaches a busy page is reported as not responding instead of a timeout",
    failedChecks({
      failed: !result.ok,
      code: !result.ok && result.error.code === "browser_timeout",
      message: !result.ok && result.error.message.includes("is not responding"),
      // Dialog setup (3 s DevTools deadline) plus the in-command check (3 s + 1.5 s).
      fast: Date.now() - started < 9000,
      marked: health.get(busyGuestId)?.state === "not_responding",
    }),
    { result, ms: Date.now() - started, health: health.get(busyGuestId) },
  );
  busyGuest.forcefullyCrashRenderer();
  const crashDeadline = Date.now() + 5000;
  while (health.get(busyGuestId)?.state !== "crashed" && Date.now() < crashDeadline) {
    await delay(50);
  }
  delta92Check(
    checks,
    "a crashed renderer is recorded with its reason",
    failedChecks({ crashed: health.get(busyGuestId)?.state === "crashed" }),
    { health: health.get(busyGuestId) },
  );
}

async function runDebuggingGroup() {
  const target = await startDebuggingServer();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "debugging harness window loadFile",
    );
    await waitForInactiveReveal(handle, "debugging harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${target.origin}/?first`,
    });
    await waitForGuestLoad(guest);
    const harness = createFramesAutomation(guest);
    await verifyDebugEvaluate(harness);
    await verifyDebugLogs(harness, target.origin);
    const buyRef = await verifyDebugSnapshots(harness);
    await verifyDebugElementScreenshot(harness, buyRef);
    await verifyDebugStyles(harness, buyRef);
    await verifyDebugEmulation(harness, target.origin);
    return [
      "evaluate-csp",
      "logs",
      "snapshot-scope",
      "element-screenshot",
      "styles",
      "emulation",
    ].map((check) => ({ group: "debugging", check, pass: true }));
  } finally {
    if (!win.isDestroyed()) win.close();
    await closeServer(target.server);
  }
}

function failedChecks(checks) {
  return Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
}

async function verifyDebugEvaluate(harness) {
  const { browserId } = harness;
  const evaluated = await harness.run("evaluate under CSP", {
    command: "evaluate",
    args: { browserId, function: "() => document.title // comment" },
  });
  const syntax = await harness.execute({
    command: "evaluate",
    args: { browserId, function: "() => { return 1" },
  });
  const failed = failedChecks({
    csp: evaluated.resultJson === '"Debug fixture"',
    syntax:
      !syntax.ok && syntax.error.message.startsWith("browser_evaluate function has a syntax error"),
  });
  if (failed.length > 0) {
    fail(`evaluate checks failed (${failed}): ${JSON.stringify({ evaluated, syntax })}`);
  }
  pass("evaluate runs on a CSP + Trusted Types page and reports syntax errors");
}

async function verifyDebugLogs(harness, origin) {
  const { browserId, guest } = harness;
  // The console is observed from adaptWebContents on (production adapts at attach);
  // load the first page again now that it is.
  for (const query of ["first", "second"]) {
    await harness.run(`navigate ${query}`, {
      command: "navigate",
      args: { browserId, url: `${origin}/?${query}` },
    });
    await waitForGuestLoad(guest);
  }
  const logs = await harness.run("logs error level", {
    command: "logs",
    args: { browserId, maxEntries: 50, level: "error" },
  });
  const first = logs.console.find((entry) => entry.message.includes("?first"));
  const second = logs.console.find((entry) => entry.message.includes("?second"));
  const failed = failedChecks({
    firstMarked: first?.previousPage === true,
    secondCurrent: Boolean(second) && !second.previousPage,
    levelFiltered: logs.console.every((entry) => entry.level === "error"),
  });
  if (failed.length > 0) {
    fail(`logs checks failed (${failed}): ${JSON.stringify(logs.console)}`);
  }
  pass("logs marks the earlier page's messages and filters by level");
}

async function verifyDebugSnapshots(harness) {
  const { browserId } = harness;
  const { snapshot } = await harness.run("snapshot", { command: "snapshot", args: { browserId } });
  const buyRef = /button "Buy now" \[ref=(@e\d+)\]/.exec(snapshot)?.[1];
  if (!buyRef) fail(`snapshot has no Buy now ref:\n${snapshot}`);
  const interactive = await harness.run("interactive snapshot", {
    command: "snapshot",
    args: { browserId, interactive: true },
  });
  const scoped = await harness.run("scoped snapshot", {
    command: "snapshot",
    args: { browserId, ref: buyRef },
  });
  const failed = failedChecks({
    dropsText: !interactive.snapshot.includes("Long text"),
    keepsLandmark: interactive.snapshot.includes('navigation "Main"'),
    keepsButton: interactive.snapshot.includes('button "Open cart"'),
    scoped: scoped.snapshot.trim() === `- button "Buy now" [ref=${buyRef}]`,
  });
  if (failed.length > 0) {
    fail(`snapshot checks failed (${failed}):\n${interactive.snapshot}\n---\n${scoped.snapshot}`);
  }
  pass("snapshot scopes to a ref and keeps only interactive elements");
  return buyRef;
}

async function verifyDebugElementScreenshot(harness, buyRef) {
  const shot = await harness.run("element screenshot", {
    command: "screenshot",
    args: { browserId: harness.browserId, fullPage: false, ref: buyRef },
  });
  const ratio = shot.width / 120;
  if (ratio < 1 || ratio > 3 || Math.abs(shot.height / ratio - 40) > 2) {
    fail(`element screenshot size ${shot.width}x${shot.height} does not match the 120x40 button`);
  }
  pass(`element screenshot captures the button only (${shot.width}x${shot.height})`);
}

async function verifyDebugStyles(harness, buyRef) {
  const styles = await harness.run("styles", {
    command: "styles",
    args: { browserId: harness.browserId, ref: buyRef, maxRules: 30 },
  });
  const colorRules = styles.rules
    .filter((rule) => !rule.inheritedFrom && rule.declarations.some((d) => d.name === "color"))
    .map((rule) => {
      const color = rule.declarations.find((d) => d.name === "color");
      return `${rule.selector}${color.overridden ? "!" : ""}`;
    });
  const body = styles.rules.find((rule) => rule.selector === "body");
  const failed = failedChecks({
    cascade: colorRules.join(" > ") === "element.style > #buy! > .card button!",
    source: Boolean(body?.source?.endsWith("/app.css")) && body.line === 1,
    computed: styles.computed.width === "120px",
    userAgent: styles.userAgentRules > 0,
  });
  if (failed.length > 0) {
    fail(`styles checks failed (${failed}): ${JSON.stringify(styles)}`);
  }
  pass("styles orders rules by precedence with sheet URL and line, computed values, UA count");
}

async function verifyDebugEmulation(harness, origin) {
  const { browserId, guest } = harness;
  const emulated = await harness.run("resize mobile", {
    command: "resize",
    args: { browserId, width: 390, height: 700, mobile: true },
  });
  await harness.run("navigate ua", {
    command: "navigate",
    args: { browserId, url: `${origin}/ua` },
  });
  await waitForGuestLoad(guest);
  const phone = await guest.executeJavaScript(
    `({
      header: document.getElementById('ua').textContent,
      agent: navigator.userAgent,
      coarse: matchMedia('(pointer: coarse)').matches,
      noHover: matchMedia('(hover: none)').matches,
      touch: 'ontouchstart' in window,
      maxTouchPoints: navigator.maxTouchPoints,
      dpr: devicePixelRatio,
      chMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
      chPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    })`,
    true,
  );
  const failed = failedChecks({
    reported: emulated.emulation?.mobile === true,
    header: /Android.*Mobile/.test(phone.header),
    agent: /Android/.test(phone.agent),
    coarse: phone.coarse,
    noHover: phone.noHover,
    touch: phone.touch && phone.maxTouchPoints > 0,
    dpr: phone.dpr === 3,
    clientHints: phone.chMobile === true && phone.chPlatform === "Android",
  });
  if (failed.length > 0) {
    fail(`mobile emulation incomplete (${failed}): ${JSON.stringify({ emulated, phone })}`);
  }
  await harness.run("resize clear", {
    command: "resize",
    args: { browserId, width: 1000, height: 700 },
  });
  await harness.run("reload ua", { command: "reload", args: { browserId } });
  await waitForGuestLoad(guest);
  const desktop = await guest.executeJavaScript(
    `({ header: document.getElementById('ua').textContent, coarse: matchMedia('(pointer: coarse)').matches })`,
    true,
  );
  if (/Android/.test(desktop.header) || desktop.coarse) {
    fail(`mobile emulation did not clear: ${JSON.stringify(desktop)}`);
  }
  pass(
    `mobile emulation reaches the server UA, media queries, touch, DPR, client hints; clears (${JSON.stringify(phone)})`,
  );
}

// Delta 97: a frozen tab unused past the idle time is discarded without memory pressure, through
// the production discard check, blockers, read-only tab report, and IPC handler against three real
// guests: one an agent typed into, one shown in a pane, one left alone. Only the last is discarded,
// and its first command after the discard waits for the reloaded document.
const DISCARD_THROTTLE_MS = 1_000;
const DISCARD_FREEZE_MS = 2_000;
const DISCARD_IDLE_MS = 5_000;
const DISCARD_BROWSER_IDS = {
  typed: "55555555-5555-4555-8555-555555555551",
  visible: "55555555-5555-4555-8555-555555555552",
  idle: "55555555-5555-4555-8555-555555555553",
};

async function startDiscardServer() {
  const server = http.createServer((request, response) => {
    const name = (request.url || "/").replace(/^\/+/, "") || "idle";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // The idle page holds its body back briefly, so a wake that did not wait for the reloaded
    // document would snapshot an empty page.
    const body = `<!doctype html><html><head><title>Discard ${name}</title></head>
      <body><h1>Discard ${name} page</h1>
        <label>Note <input aria-label="Note" id="note"></label>
        <button>Discard ${name} button</button>
      </body></html>`;
    if (name === "idle") {
      response.write(body.slice(0, body.indexOf("<body>")));
      setTimeout(() => response.end(body.slice(body.indexOf("<body>"))), 400);
    } else {
      response.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: (name) => `http://127.0.0.1:${server.address().port}/${name}` };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function discardKeepProblems({ afterDiscard, lifecycle, guests }) {
  const problems = [];
  const { idle, typed, visible } = afterDiscard;
  if (!idle || idle.state !== "discarded" || idle.rendererPid !== undefined)
    problems.push(`idle tab: ${JSON.stringify(idle)}`);
  if (!typed || typed.state !== "frozen" || typed.discardBlockedBy !== "edited")
    problems.push(`typed tab: ${JSON.stringify(typed)}`);
  if (typed && !(typed.footprintBytes > 0)) problems.push("typed tab has no footprint");
  if (!visible || visible.state !== "active" || visible.held !== true)
    problems.push(`visible tab: ${JSON.stringify(visible)}`);
  for (const name of ["typed", "visible"]) {
    if (lifecycle.getState(guests[name].id) === "discarded" || guests[name].isCrashed())
      problems.push(`${name} tab lost its renderer`);
  }
  return problems;
}

async function openDiscardHarnessTabs({ win, tracker, webviews, fixture, workspaceId }) {
  const guests = {};
  for (const [name, browserId] of Object.entries(DISCARD_BROWSER_IDS)) {
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: fixture.url(name),
    });
    webviews.preparePaseoBrowserWebContents(guest, { discardable: true });
    webviews.registerManagedPaseoBrowserTarget({
      browserId,
      workspaceId,
      webContentsId: guest.id,
      hostWebContentsId: win.webContents.id,
      metadata: { kind: "tab" },
    });
    await waitForGuestLoad(guest, { settleMs: 0 });
    // Reload once now that main watches the guest, so the edit watcher runs in this document,
    // as it does for every tab the app opens.
    guest.reload();
    await new Promise((resolve) => guest.once("did-finish-load", resolve));
    guests[name] = guest;
  }
  return guests;
}

async function runDiscardChecksUntilDiscarded({ webviews, lifecycle, guest, report }) {
  const deadline = Date.now() + DISCARD_IDLE_MS + 15_000;
  let checks = 0;
  while (lifecycle.getState(guest.id) !== "discarded") {
    if (Date.now() > deadline) fail(`idle tab never discarded: ${JSON.stringify(await report())}`);
    await webviews.runPaseoBrowserTabDiscardCheck();
    checks += 1;
    await delay(250);
  }
  // Keep checking a while longer: the typed and visible tabs must still be kept.
  const discardedAt = Date.now();
  while (Date.now() - discardedAt < 3_000) {
    await webviews.runPaseoBrowserTabDiscardCheck();
    await delay(250);
  }
  return checks;
}

async function runTabDiscardGroup() {
  process.env.PASEO_BROWSER_TAB_LIFECYCLE_MS = `${DISCARD_THROTTLE_MS},${DISCARD_FREEZE_MS},${DISCARD_IDLE_MS}`;
  const webviews = require(path.join(DIST_DIR, "features", "browser-webviews", "index.js"));
  const { registerBrowserAutomationIpc } = require(PRODUCTION_BROWSER_AUTOMATION_IPC_PATH);
  const handlers = new Map();
  registerBrowserAutomationIpc({
    ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  const lifecycle = webviews.getPaseoBrowserTabLifecycle();
  const fixture = await startDiscardServer();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win);
  const workspaceId = "discard-harness-workspace";
  const host = { id: win.webContents.id, isDestroyed: () => false, once: () => {}, send: () => {} };
  let requestCounter = 0;
  const execute = async (command) => {
    const payload = await handlers.get("paseo:browser:execute-automation-command")(
      { sender: host },
      {
        type: "browser.automation.execute.request",
        requestId: `discard-${(requestCounter += 1)}`,
        workspaceId,
        command,
      },
    );
    if (!payload.ok) fail(`${command.command} failed: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };
  const report = async () => {
    const result = await webviews.reportPaseoBrowserTabs();
    return Object.fromEntries(
      Object.entries(DISCARD_BROWSER_IDS).map(([name, browserId]) => [
        name,
        result.tabs.find((tab) => tab.browserId === browserId),
      ]),
    );
  };
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "discard harness window loadFile",
    );
    await waitForInactiveReveal(handle, "discard harness window");
    const guests = await openDiscardHarnessTabs({ win, tracker, webviews, fixture, workspaceId });
    // A person has the visible tab on screen.
    webviews.setPaseoBrowserPresented({
      hostWebContentsId: win.webContents.id,
      browserId: DISCARD_BROWSER_IDS.visible,
      presented: true,
    });
    // An agent typed into the typed tab.
    const typedSnapshot = await execute({
      command: "snapshot",
      args: { browserId: DISCARD_BROWSER_IDS.typed },
    });
    const noteRef = typedSnapshot.snapshot.match(/textbox "Note" \[(?:[^\]]* )?ref=(@e\d+)\]/)?.[1];
    if (!noteRef) fail(`discard fixture textbox missing: ${typedSnapshot.snapshot}`);
    await execute({
      command: "type",
      args: { browserId: DISCARD_BROWSER_IDS.typed, ref: noteRef, text: "unsaved draft" },
    });

    const idlePid = guests.idle.getOSProcessId();
    const checks = await runDiscardChecksUntilDiscarded({
      webviews,
      lifecycle,
      guest: guests.idle,
      report,
    });
    const afterDiscard = await report();
    const problems = discardKeepProblems({ afterDiscard, lifecycle, guests });
    const pidDeadline = Date.now() + 3_000;
    while (isProcessAlive(idlePid) && Date.now() < pidDeadline) await delay(100);
    if (isProcessAlive(idlePid)) problems.push(`idle renderer ${idlePid} still running`);
    if (problems.length > 0) fail(`tab-discard keep/discard: ${problems.join("; ")}`);
    pass(
      `tab-discard only the idle tab was discarded after ${checks} checks (renderer ${idlePid} ended); typed kept=${afterDiscard.typed.discardBlockedBy} ${Math.round(afterDiscard.typed.footprintBytes / 1048576)} MB, visible ${afterDiscard.visible.state} held`,
    );

    const restoreStarted = Date.now();
    const snapshot = await execute({
      command: "snapshot",
      args: { browserId: DISCARD_BROWSER_IDS.idle },
    });
    const restoreMs = Date.now() - restoreStarted;
    if (!snapshot.snapshot.includes("Discard idle button"))
      fail(`snapshot after discard missed the reloaded page: ${snapshot.snapshot}`);
    if (lifecycle.getState(guests.idle.id) !== "active")
      fail(`woken tab is ${lifecycle.getState(guests.idle.id)}`);
    const { idle: woken } = await report();
    if (!woken || !(woken.rendererPid > 0) || woken.rendererPid === idlePid)
      fail(`woken tab has no new renderer: ${JSON.stringify(woken)}`);
    pass(
      `tab-discard browser_snapshot on the discarded tab reloaded it in ${restoreMs}ms (new renderer ${woken.rendererPid}, title=${JSON.stringify(snapshot.title)})`,
    );
    return [
      { group: "tab-discard", check: "keep-and-discard", checks, report: afterDiscard, pass: true },
      { group: "tab-discard", check: "snapshot-after-discard", restoreMs, pass: true },
    ];
  } finally {
    webviews.setPaseoBrowserPresented({
      hostWebContentsId: win.webContents.id,
      browserId: DISCARD_BROWSER_IDS.visible,
      presented: false,
    });
    if (!win.isDestroyed()) win.close();
    await closeServer(fixture.server);
  }
}

// Delta 100: browser_click and Enter/Space browser_keypress say what the input caused, and
// find/snapshot show a modal that is still fading in. The fixture page mounts its dialog at
// opacity 0 and starts a 400 ms opacity transition 120 ms later (the pattern Vercel's modal
// uses), posts a form to a route that answers after 1.5 s, toggles aria-expanded, cancels one
// submit in a page handler, and has a button that does nothing.
async function startClickEffectServer() {
  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/slow")) {
      request.resume();
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Posted</title><p>posted</p>");
      }, 1_500);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.startsWith("/next")) {
      response.end("<!doctype html><title>Next</title><p>next page</p>");
      return;
    }
    response.end(`<!doctype html><title>Click effect fixture</title>
      <style>
        body { margin: 0; font-family: sans-serif; }
        main button, main a { display: block; margin: 8px; }
        .modal { position: fixed; left: 300px; top: 40px; width: 300px; height: 200px;
          background: white; border: 1px solid #888; transition: opacity 400ms ease, transform 400ms ease; }
      </style>
      <main>
        <button id="fade">Open fade dialog</button>
        <button id="noop">Do nothing</button>
        <button id="toggle" aria-expanded="false">Toggle panel</button>
        <form method="post" action="/slow"><button id="post">Slow post</button></form>
        <a id="link" href="/next">Next page</a>
        <form id="guarded" method="post" action="/slow"><button id="guard">Guarded submit</button></form>
      </main>
      <script>
        window.events = [];
        for (const type of ["pointerdown", "mousedown", "focus", "pointerup", "mouseup", "click"]) {
          document.addEventListener(type, (event) => {
            if (event.target && event.target.id === "noop") {
              window.events.push(type + ":" + (event.buttons ?? "") + ":" + (document.activeElement === event.target));
            }
          }, true);
        }
        document.getElementById("fade").addEventListener("click", () => {
          const dialog = document.createElement("div");
          dialog.className = "modal";
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-label", "Fade dialog");
          dialog.style.opacity = "0";
          dialog.innerHTML = "<h3>Fade dialog</h3><button>Close fade</button>";
          document.body.append(dialog);
          setTimeout(() => { dialog.style.opacity = "1"; }, 120);
        });
        const toggle = document.getElementById("toggle");
        toggle.addEventListener("click", () => {
          toggle.setAttribute("aria-expanded", toggle.getAttribute("aria-expanded") === "true" ? "false" : "true");
        });
        document.getElementById("guarded").addEventListener("submit", (event) => event.preventDefault());
      </script>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// The navigate command returns at commit; a did-finish-load listener attached after that can miss
// the event, so this polls the loading state with a deadline instead.
async function settleClickEffectGuest(guest) {
  const deadline = Date.now() + 10_000;
  while (guest.isLoading() && Date.now() < deadline) await delay(50);
  if (guest.isLoading()) fail("click-effect guest still loading after 10 s");
  await delay(100);
}

async function runClickEffectGroup() {
  const target = await startClickEffectServer();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  const results = [];
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "click-effect harness window loadFile",
    );
    await waitForInactiveReveal(handle, "click-effect harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${target.origin}/`,
    });
    await settleClickEffectGuest(guest);
    const fixture = createClickEffectFixture(createFramesAutomation(guest), target.origin, results);
    await verifyClickEffectFadeIn(fixture);
    await verifyClickEffectNoOp(fixture);
    await verifyClickEffectToggle(fixture);
    await verifyClickEffectNavigations(fixture);
    const failed = results.filter((result) => !result.pass).map((result) => result.check);
    if (failed.length > 0) fail(`click-effect checks failed: ${failed.join(", ")}`);
    return results;
  } finally {
    await fsp.writeFile(
      path.join(OUT_DIR, "click-effect-results.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    );
    if (!win.isDestroyed()) win.close();
    await closeServer(target.server);
  }
}

function createClickEffectFixture(harness, origin, results) {
  const { browserId, guest } = harness;
  const timed = async (command) => {
    const started = Date.now();
    const response = await withTimeout(
      harness.execute(command),
      `click-effect ${command.command} ${command.args.ref ?? ""}`,
      15_000,
    );
    return { response, ms: Date.now() - started, effect: response.result?.effect ?? "" };
  };
  return {
    harness,
    browserId,
    guest,
    timed,
    click: (ref) => timed({ command: "click", args: { browserId, ref } }),
    record(check, ok, detail) {
      results.push({ group: "click-effect", check, pass: ok, ...detail });
      console.log(`${ok ? "PASS" : "FAIL"} click-effect ${check} ${JSON.stringify(detail)}`);
    },
    // Loads the fixture page and returns the ref of the named control from a fresh snapshot.
    async open() {
      await withTimeout(
        harness.run("navigate fixture", {
          command: "navigate",
          args: { browserId, url: `${origin}/` },
        }),
        "click-effect navigate",
        15_000,
      );
      await settleClickEffectGuest(guest);
      const { snapshot } = await withTimeout(
        harness.run("snapshot", { command: "snapshot", args: { browserId } }),
        "click-effect snapshot",
        15_000,
      );
      return (line) => {
        const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const ref = new RegExp(`${escaped} \\[(?:[a-z]+=[^\\]\\s]+ )*ref=(@e\\d+)\\]`).exec(
          snapshot,
        )?.[1];
        if (!ref) fail(`click-effect snapshot has no ref for ${line}:\n${snapshot}`);
        return ref;
      };
    },
  };
}

// A modal mounted at opacity 0: the click names it, and an immediate find and snapshot show it.
async function verifyClickEffectFadeIn(fixture) {
  const { browserId, harness } = fixture;
  const refOf = await fixture.open();
  const fade = await fixture.click(refOf('button "Open fade dialog"'));
  // The service is called directly here, so limit is passed (the tool schema defaults it to 10).
  const found = await harness.execute({
    command: "find",
    args: { browserId, role: "dialog", limit: 10 },
  });
  const snapped = await harness.execute({ command: "snapshot", args: { browserId } });
  fixture.record(
    "fade-in click effect",
    /dialog/.test(fade.effect) && /appearing|fading/.test(fade.effect),
    { ms: fade.ms, effect: fade.effect },
  );
  const matches = found.ok ? found.result.matches : [];
  fixture.record(
    "fade-in find",
    matches.length === 1 && matches[0].states.includes("appearing=true"),
    { matches },
  );
  const dialogLine = snapped.ok
    ? (/.*dialog "Fade dialog".*/.exec(snapped.result.snapshot)?.[0] ?? null)
    : null;
  fixture.record("fade-in snapshot", dialogLine !== null, { dialogLine });
}

// A button that does nothing: said so after the window, never a bare "Clicked"; and the
// background click's events in a real click's order and fields.
async function verifyClickEffectNoOp(fixture) {
  const refOf = await fixture.open();
  const noop = await fixture.click(refOf('button "Do nothing"'));
  fixture.record("no-op click effect", /no change/.test(noop.effect) && noop.ms < 900, {
    ms: noop.ms,
    effect: noop.effect,
  });
  const events = await fixture.guest.executeJavaScript("window.events", true);
  // Focus moves between mousedown and pointerup. Chromium fires no focus event in a guest page
  // that does not have focus itself, so activeElement shows it.
  fixture.record(
    "no-op click event sequence",
    isDeepStrictEqual(events, [
      "pointerdown:1:false",
      "mousedown:1:false",
      "pointerup:0:true",
      "mouseup:0:true",
      "click:0:true",
    ]),
    { events },
  );
}

// An immediate effect returns at once, on the background and the trusted path.
async function verifyClickEffectToggle(fixture) {
  const { browserId, guest, harness } = fixture;
  const refOf = await fixture.open();
  const toggleRef = refOf('button "Toggle panel"');
  const toggle = await fixture.click(toggleRef);
  fixture.record("toggle click effect", /expanded/.test(toggle.effect), {
    ms: toggle.ms,
    effect: toggle.effect,
  });
  harness.state.inputFocused = true;
  const trusted = await fixture.click(toggleRef);
  harness.state.inputFocused = false;
  fixture.record("toggle trusted click effect", /expanded/.test(trusted.effect), {
    ms: trusted.ms,
    effect: trusted.effect,
  });
  // In this inactive harness window a trusted key does not reach a background guest (the committed
  // build behaves the same), so the check is that the result tells the truth either way.
  const expandedState = "document.getElementById('toggle').getAttribute('aria-expanded')";
  const before = await guest.executeJavaScript(expandedState, true);
  const keyed = await fixture.timed({
    command: "keypress",
    args: { browserId, ref: toggleRef, key: "Enter" },
  });
  const toggledByKey = (await guest.executeJavaScript(expandedState, true)) !== before;
  fixture.record(
    "toggle Enter keypress effect",
    toggledByKey ? /expanded/.test(keyed.effect) : /no change/.test(keyed.effect),
    { ms: keyed.ms, effect: keyed.effect, toggledByKey },
  );
}

// A form post whose response takes 1.5 s and a link: the navigation is named as soon as it
// starts. A submit the page cancels is named after the window.
async function verifyClickEffectNavigations(fixture) {
  let refOf = await fixture.open();
  const post = await fixture.click(refOf('button "Slow post"'));
  fixture.record("slow post click effect", /navigation/.test(post.effect) && post.ms < 1_000, {
    ms: post.ms,
    effect: post.effect,
  });
  await settleClickEffectGuest(fixture.guest);

  refOf = await fixture.open();
  const link = await fixture.click(refOf('link "Next page"'));
  fixture.record("link click effect", /navigation/.test(link.effect), {
    ms: link.ms,
    effect: link.effect,
  });
  await settleClickEffectGuest(fixture.guest);

  refOf = await fixture.open();
  const guard = await fixture.click(refOf('button "Guarded submit"'));
  fixture.record(
    "cancelled submit click effect",
    /submit/.test(guard.effect) && /cancel/.test(guard.effect),
    { ms: guard.ms, effect: guard.effect },
  );
}

// Delta 104: an action sent with snapshot answers with the settled page, and browser_wait settled
// (the settle command) ends when the page is quiet. The fixture page has a button whose fetch takes
// 600 ms before it renders, a button that starts a ticker that never stops, and a /late page that
// renders content 300 ms after load from a fetch.
async function startPageSettleServer() {
  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/api/slow") || url.startsWith("/api/late")) {
      setTimeout(
        () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ count: 3 }));
        },
        url.startsWith("/api/slow") ? 600 : 300,
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.startsWith("/late")) {
      response.end(`<!doctype html><title>Late</title><main><h1>Late page</h1></main>
        <script>
          fetch("/api/late").then((r) => r.json()).then(() => {
            document.querySelector("main").insertAdjacentHTML("beforeend", "<h2>Late content</h2>");
          });
        </script>`);
      return;
    }
    response.end(`<!doctype html><title>Settle fixture</title>
      <main>
        <button id="load">Load results</button>
        <button id="tick">Start ticker</button>
        <p id="ticker">idle</p>
      </main>
      <script>
        document.getElementById("load").addEventListener("click", async () => {
          const data = await (await fetch("/api/slow")).json();
          document.querySelector("main").insertAdjacentHTML("beforeend", "<h2>" + data.count + " results</h2>");
        });
        document.getElementById("tick").addEventListener("click", () => {
          let n = 0;
          setInterval(() => { document.getElementById("ticker").textContent = "tick " + (n += 1); }, 50);
        });
      </script>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runPageSettleGroup() {
  const target = await startPageSettleServer();
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });
  const { win } = handle;
  installHarnessWebviewGuards(win);
  const tracker = trackAttachedGuests(win, { disableGuestBackgroundThrottlingAtAttach: true });
  const results = [];
  try {
    await withTimeout(
      win.loadFile(path.join(ROOT, "index.html"), {
        query: { webviewCount: "0", permanentParkingState: "p1-overflow-1x1" },
      }),
      "page-settle harness window loadFile",
    );
    await waitForInactiveReveal(handle, "page-settle harness window");
    const { guest } = await appendPermanentWebview({
      win,
      tracker,
      state: { id: "p1-overflow-1x1" },
      sourceUrl: `${target.origin}/`,
    });
    await settleClickEffectGuest(guest);
    const fixture = createPageSettleFixture(createFramesAutomation(guest), target.origin, results);
    await verifyPageSettleClicks(fixture);
    await verifyPageSettleWaits(fixture);
    await verifyPageSettleNavigate(fixture);
    const failed = results.filter((result) => !result.pass).map((result) => result.check);
    if (failed.length > 0) fail(`page-settle checks failed: ${failed.join(", ")}`);
    return results;
  } finally {
    await fsp.writeFile(
      path.join(OUT_DIR, "page-settle-results.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
    );
    if (!win.isDestroyed()) win.close();
    await closeServer(target.server);
  }
}

function createPageSettleFixture(harness, origin, results) {
  const { browserId, guest } = harness;
  return {
    harness,
    browserId,
    origin,
    record(check, ok, detail) {
      results.push({ group: "page-settle", check, pass: ok, ...detail });
      console.log(`${ok ? "PASS" : "FAIL"} page-settle ${check} ${JSON.stringify(detail)}`);
    },
    async timed(label, command) {
      const started = Date.now();
      const response = await withTimeout(harness.execute(command), `page-settle ${label}`, 30_000);
      return { response, ms: Date.now() - started };
    },
    // Loads the fixture page and returns the ref of the named control from a fresh snapshot.
    async open() {
      await harness.run("navigate fixture", {
        command: "navigate",
        args: { browserId, url: `${origin}/` },
      });
      await settleClickEffectGuest(guest);
      const { snapshot } = await harness.run("snapshot", {
        command: "snapshot",
        args: { browserId },
      });
      return (line) => {
        const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const ref = new RegExp(`${escaped} \\[(?:[a-z]+=[^\\]\\s]+ )*ref=(@e\\d+)\\]`).exec(
          snapshot,
        )?.[1];
        if (!ref) fail(`page-settle snapshot has no ref for ${line}:\n${snapshot}`);
        return ref;
      };
    },
  };
}

function snapshotText(pageAfter) {
  return pageAfter?.snapshot?.snapshot ?? "";
}

// Without the argument the click answers as before; with it, the click's own 600 ms fetch is
// waited for and its rendered result is in the snapshot.
async function verifyPageSettleClicks(fixture) {
  const { browserId } = fixture;
  let refOf = await fixture.open();
  const plain = await fixture.timed("plain click", {
    command: "click",
    args: { browserId, ref: refOf('button "Load results"') },
  });
  fixture.record(
    "click without snapshot unchanged",
    plain.response.ok && !("pageAfter" in plain.response) && plain.ms < 1_500,
    { ms: plain.ms, effect: plain.response.result?.effect },
  );

  refOf = await fixture.open();
  const clicked = await fixture.timed("click snapshot", {
    command: "click",
    args: { browserId, ref: refOf('button "Load results"'), snapshot: true },
  });
  const pageAfter = clicked.response.pageAfter;
  const hasResults = /heading "3 results"/.test(snapshotText(pageAfter));
  fixture.record(
    "click snapshot after a 600 ms fetch",
    clicked.response.ok &&
      pageAfter?.settled === true &&
      pageAfter.networkWatched !== false &&
      hasResults &&
      clicked.ms >= 600 &&
      clicked.ms < 3_000,
    {
      ms: clicked.ms,
      settledInMs: pageAfter?.elapsedMs,
      effect: clicked.response.result?.effect,
      snapshotHasResults: hasResults,
    },
  );
}

// An already quiet page settles in about the quiet window; one that never stops changing ends at
// the bound, not settled.
async function verifyPageSettleWaits(fixture) {
  const { browserId } = fixture;
  const quiet = await fixture.timed("settle quiet", { command: "settle", args: { browserId } });
  fixture.record(
    "settle on a quiet page",
    quiet.response.ok && quiet.response.result.settled === true && quiet.ms < 1_000,
    { ms: quiet.ms, settledInMs: quiet.response.result?.elapsedMs },
  );

  const refOf = await fixture.open();
  await fixture.harness.run("start ticker", {
    command: "click",
    args: { browserId, ref: refOf('button "Start ticker"') },
  });
  const busy = await fixture.timed("settle busy", {
    command: "settle",
    args: { browserId, timeoutMs: 1_500 },
  });
  const result = busy.response.ok ? busy.response.result : null;
  fixture.record(
    "settle on a never-quiet page ends at the bound",
    result?.settled === false &&
      result.domChangedMsAgo !== undefined &&
      busy.ms >= 1_500 &&
      busy.ms < 3_000,
    { ms: busy.ms, result },
  );
}

// A navigation's snapshot is the new document after its late content rendered.
async function verifyPageSettleNavigate(fixture) {
  const url = `${fixture.origin}/late`;
  const navigated = await fixture.timed("navigate snapshot", {
    command: "navigate",
    args: { browserId: fixture.browserId, url, snapshot: true },
  });
  const late = navigated.response.pageAfter;
  const hasLateContent = /heading "Late content"/.test(snapshotText(late));
  fixture.record(
    "navigate snapshot reads the new document after it settles",
    navigated.response.ok && late?.settled === true && late.snapshot?.url === url && hasLateContent,
    { ms: navigated.ms, settledInMs: late?.elapsedMs, url: late?.snapshot?.url, hasLateContent },
  );
}

// Groups that run on their own: each writes results.json under its own key.
const SINGLE_GROUPS = {
  "click-effect": ["clickEffectResults", runClickEffectGroup],
  "page-settle": ["pageSettleResults", runPageSettleGroup],
  "tab-lifecycle": ["tabLifecycleResults", runTabLifecycleGroup],
  "tab-discard": ["tabDiscardResults", runTabDiscardGroup],
  dialogs: ["dialogsResults", runDialogsGroup],
  delta92: ["delta92Results", runDelta92Group],
  passkeys: ["passkeysResults", runPasskeysGroup],
  debugging: ["debuggingResults", runDebuggingGroup],
  "frames-network": ["framesNetworkResults", runFramesNetworkGroup],
  "cross-origin-frames": ["crossOriginFramesResults", runCrossOriginFramesGroup],
  "browser-profile": ["browserProfileResults", runBrowserProfileGroup],
  automation: ["automationResults", runAutomationGroup],
  "permanent-parking": ["permanentParkingResults", runPermanentParkingGroup],
};

async function main() {
  ensureDirSync(OUT_DIR);
  const single = SINGLE_GROUPS[HARNESS_GROUP];
  if (!single && !["all", "existing"].includes(HARNESS_GROUP)) {
    fail(`unknown harness group ${HARNESS_GROUP}`);
  }
  if (single) {
    const [resultsKey, runGroup] = single;
    const results = await runGroup();
    await fsp.writeFile(
      path.join(OUT_DIR, "results.json"),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), [resultsKey]: results }, null, 2)}\n`,
    );
    pass(`capture harness ${HARNESS_GROUP} complete output=${OUT_DIR}`);
    return;
  }

  const attachedGuests = [];
  const freshGuestWaiters = [];
  let resolveGuests;
  const guestsPromise = new Promise((resolve) => {
    resolveGuests = resolve;
  });
  const waitForNextAttachedGuest = () =>
    new Promise((resolve) => {
      freshGuestWaiters.push(resolve);
    });
  const handle = createInactiveHarnessWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#202020",
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const { win } = handle;

  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  win.webContents.on("did-attach-webview", (_event, contents) => {
    attachedGuests.push(contents);
    const waiter = freshGuestWaiters.shift();
    if (waiter) {
      waiter(contents);
    }
    if (attachedGuests.length >= 2) {
      resolveGuests(attachedGuests);
    }
  });

  await win.loadFile(path.join(ROOT, "index.html"), {
    query: { targetUrl: fileUrl(path.join(ROOT, "bright.html")), webviewCount: "2" },
  });
  await waitForInactiveReveal(handle, "capture harness window");
  await withTimeout(guestsPromise, "did-attach-webview");
  await Promise.all(attachedGuests.map((guest) => waitForGuestLoad(guest)));
  await renderer(win, "window.captureHarness.waitForFrames(2)");
  const webContentsIds = await renderer(win, "window.captureHarness.webContentsIds()");
  const guestsById = new Map(attachedGuests.map((guest) => [guest.id, guest]));
  const guests = webContentsIds.map((id) => guestsById.get(id));
  if (guests.some((guest) => !guest)) {
    fail(
      `could not map webviews to guest contents ids=${JSON.stringify(webContentsIds)} attached=${attachedGuests.map((guest) => guest.id).join(",")}`,
    );
  }
  const guestMetrics = await Promise.all(guests.map((guest) => readGuestMetrics(guest)));

  guestMetrics.forEach((metrics, index) => {
    if (metrics.innerWidth !== VIEWPORT_WIDTH || metrics.innerHeight !== VIEWPORT_HEIGHT) {
      fail(
        `guest viewport sizing webview ${index + 1} inner=${metrics.innerWidth}x${metrics.innerHeight} expected=${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
      );
    }
    pass(
      `guest viewport sizing webview ${index + 1} inner=${metrics.innerWidth}x${metrics.innerHeight} dpr=${metrics.devicePixelRatio}`,
    );
  });

  await renderer(win, "window.captureHarness.restoreParking()");
  try {
    const image = await capturePageSequence(guests[0]);
    const analysis = analyzeImage(
      image,
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, minBrightRatio: 0.65 },
      guestMetrics[0],
    );
    fail(
      `parked webview unexpectedly captured size=${analysis.width}x${analysis.height} bright=${analysis.brightRatio.toFixed(4)}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pass(`parked webview has no copyable viewport frame error=${message}`);
  }

  await expectLegacySecondWebviewFailure({
    win,
    contents: guests[1],
    mode: "viewport",
    guestMetrics: guestMetrics[1],
  });
  await expectLegacySecondWebviewFailure({
    win,
    contents: guests[1],
    mode: "full-page",
    guestMetrics: guestMetrics[1],
  });

  await renderer(win, "window.captureHarness.restoreParking()");

  await captureFreshDelayedWebview({ win, waitForNextAttachedGuest, mode: "viewport" });
  await renderer(win, "window.captureHarness.restoreParking()");
  await captureFreshDelayedWebview({ win, waitForNextAttachedGuest, mode: "full-page" });
  await renderer(win, "window.captureHarness.restoreParking()");

  const results = [];
  for (const targetIndex of [0, 1]) {
    for (let index = 1; index <= REPEAT_COUNT; index += 1) {
      results.push(
        await captureWithPrep({
          win,
          contents: guests[targetIndex],
          mode: "viewport",
          repeatIndex: index,
          targetIndex,
          guestMetrics: guestMetrics[targetIndex],
        }),
      );
    }
    for (let index = 1; index <= REPEAT_COUNT; index += 1) {
      results.push(
        await captureWithPrep({
          win,
          contents: guests[targetIndex],
          mode: "full-page",
          repeatIndex: index,
          targetIndex,
          guestMetrics: guestMetrics[targetIndex],
        }),
      );
    }
  }

  const permanentParkingResults = HARNESS_GROUP === "all" ? await runPermanentParkingGroup() : [];

  await fsp.writeFile(
    path.join(OUT_DIR, "results.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        guestMetrics,
        results,
        permanentParkingResults,
      },
      null,
      2,
    )}\n`,
  );
  pass(`capture harness complete output=${OUT_DIR}`);

  if (!win.isDestroyed()) {
    win.close();
  }
}

app
  .on("window-all-closed", () => {
    // The permanent parking sweep intentionally opens and closes many phase windows.
  })
  .whenReady()
  .then(() => {
    applyMacHarnessActivationPolicyBeforeWindows();
    return main();
  })
  .then(() => app.quit())
  .catch(async (error) => {
    console.error(error);
    try {
      await fsp.writeFile(
        path.join(OUT_DIR, "fatal-error.txt"),
        `${error && error.stack ? error.stack : String(error)}\n`,
      );
    } catch {
      // Ignore reporting failures during shutdown.
    }
    app.exit(1);
  });
