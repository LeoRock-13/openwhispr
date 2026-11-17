// FORK: note_recordings against the real database (account scoping, cascade).
// Skips where the native binding is built for Electron; run with
// ELECTRON_RUN_AS_NODE=1 npx electron --test <this file>.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir;
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getName: () => "test",
        getVersion: () => "0.0.0",
        isPackaged: false,
        on: () => {},
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let DatabaseManager;
try {
  DatabaseManager = require("../../src/helpers/database");
} finally {
  Module._load = originalLoad;
}

function setup(t, accountId = "account-a") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-recordings-db-"));
  userDataDir = dir;
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip(`better-sqlite3 isn't built for this runtime: ${error.message}`);
    return null;
  }
  // Close before removing: Windows keeps an open database file locked.
  t.after(() => {
    db.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.setActiveAccountId(accountId);
  return db;
}

const recording = (noteId, id, startedAt, extra = {}) => ({
  id,
  noteId,
  fileName: `OpenWhispr-Meeting-${id}.webm`,
  startedAt,
  durationMs: 60000,
  sizeBytes: 1000,
  ...extra,
});

test("recordings are listed per note in start order", (t) => {
  const db = setup(t);
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  const other = db.saveNote("Standup", "", "meeting").note;

  db.addNoteRecording(recording(note.id, "s2", 2000));
  db.addNoteRecording(recording(note.id, "s1", 1000));
  db.addNoteRecording(recording(other.id, "s3", 1500));

  assert.deepEqual(
    db.getNoteRecordings(note.id).map((r) => r.id),
    ["s1", "s2"]
  );
  assert.equal(db.getNoteRecording("s3").note_id, other.id);
  assert.equal(db.getNoteRecordings(note.id)[0].file_name, "OpenWhispr-Meeting-s1.webm");
});

test("adding the same session twice keeps one row with the latest values", (t) => {
  const db = setup(t);
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;

  db.addNoteRecording(recording(note.id, "s1", 1000, { sizeBytes: 10 }));
  const row = db.addNoteRecording(recording(note.id, "s1", 1000, { sizeBytes: 20 }));

  assert.equal(row.size_bytes, 20);
  assert.equal(db.getNoteRecordings(note.id).length, 1);
});

test("a recording for a missing note is rejected", (t) => {
  const db = setup(t);
  if (!db) return;
  assert.throws(() => db.addNoteRecording(recording(999999, "s1", 1000)), /FOREIGN KEY/);
});

test("hard deleting the note removes its recordings", (t) => {
  const db = setup(t);
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.addNoteRecording(recording(note.id, "s1", 1000));

  db.hardDeleteNote(note.id);

  assert.equal(db.getNoteRecordingById("s1"), null);
  assert.deepEqual(db.getAllNoteRecordingFileNames(), []);
});

test("another account's recordings stay out of the scoped reads", (t) => {
  const db = setup(t, "account-a");
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.addNoteRecording(recording(note.id, "s1", 1000));

  db.setActiveAccountId("account-b");

  assert.deepEqual(db.getNoteRecordings(note.id), []);
  assert.equal(db.getNoteRecording("s1"), null);
  assert.deepEqual(db.getVisibleNoteRecordings(), []);
  // Bookkeeping reads stay device-wide.
  assert.equal(db.getNoteRecordingById("s1").id, "s1");
  assert.deepEqual(db.getAllNoteRecordingFileNames(), ["OpenWhispr-Meeting-s1.webm"]);
});

test("expired recordings are found across accounts and can be deleted", (t) => {
  const db = setup(t, "account-a");
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.addNoteRecording(recording(note.id, "old", 1000));
  db.addNoteRecording(recording(note.id, "new", 5000));
  db.setActiveAccountId("account-b");

  assert.deepEqual(
    db.getExpiredNoteRecordings(2000).map((r) => r.id),
    ["old"]
  );
  assert.deepEqual(db.deleteNoteRecording("old"), { success: true });
  assert.deepEqual(db.deleteNoteRecording("old"), { success: false });
  assert.deepEqual(db.getExpiredNoteRecordings(2000), []);
});
