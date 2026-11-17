const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => os.tmpdir(),
        getAppPath: () => process.cwd(),
        getName: () => "test",
        getVersion: () => "0.0.0",
        isPackaged: false,
        on: () => {},
      },
      ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
      net: {},
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return [];
        }
      },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
      systemPreferences: { getMediaAccessStatus: () => "granted" },
      session: { fromPartition: () => ({}) },
      shell: {},
      dialog: {},
      clipboard: {},
      nativeImage: {},
      globalShortcut: {},
      utilityProcess: {},
      MessageChannelMain: class {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const IPCHandlers = require(handlersModulePath);
const DiarizationManager = require("../../src/helpers/diarization.js");

test.after(() => {
  Module._load = originalLoad;
});

const START_MS = 1792414000000;

// The raw capture exists only for diarization; when diarization is skipped
// nothing downstream unlinks it, so the skip path has to.
const runSkipped = ({ enabled, available }) => {
  const rawPcmPath = path.join(
    os.tmpdir(),
    `ow-diarize-raw-skip-test-${process.pid}-${Date.now()}-${Math.random()}.pcm`
  );
  fs.writeFileSync(rawPcmPath, Buffer.alloc(4800));

  const diarizationManager = new DiarizationManager();
  diarizationManager.isAvailable = () => available;

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    diarizationManager,
    speakerDiarizationEnabled: enabled,
    _diarizationSpeakerReservations: new Map(),
    _reconcileLiveSpeakerState: () => new Map(),
  });

  return new Promise((resolve) => {
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel, payload) => resolve({ payload, rawPcmPath }) },
    };
    handlers._startOrSkipDiarization(
      "diar-skip",
      rawPcmPath,
      START_MS,
      [{ id: "seg-1", source: "system", text: "hello", timestamp: START_MS + 1000 }],
      win,
      null,
      null,
      1
    );
  });
};

const waitForUnlink = async (filePath) => {
  for (let i = 0; i < 50 && fs.existsSync(filePath); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !fs.existsSync(filePath);
};

test("skipped diarization (disabled) deletes the raw meeting capture", async () => {
  const { payload, rawPcmPath } = await runSkipped({ enabled: false, available: true });
  assert.ok(payload.segments.length > 0, "the undiarized transcript is still sent");
  assert.equal(await waitForUnlink(rawPcmPath), true);
});

test("skipped diarization (unavailable) deletes the raw meeting capture", async () => {
  const { rawPcmPath } = await runSkipped({ enabled: true, available: false });
  assert.equal(await waitForUnlink(rawPcmPath), true);
});
