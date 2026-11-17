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
  assert.deepEqual(db.getAllNoteRecordings(), []);
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
  assert.deepEqual(
    db.getAllNoteRecordings().map((r) => r.file_name),
    ["OpenWhispr-Meeting-s1.webm"]
  );
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

// Transcript model (design §3.5).

test("a live meeting records its model; the same model again stays unmixed", (t) => {
  const db = setup(t);
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;

  db.recordLiveTranscriptSource(note.id, { engine: "local:nvidia", model: "parakeet" }, 1000);
  const again = db.recordLiveTranscriptSource(
    note.id,
    { engine: "local:nvidia", model: "parakeet" },
    2000
  );

  assert.equal(again.source, "live");
  assert.equal(again.mixed, 0);
  assert.equal(again.updated_at, 2000);
  assert.equal(db.getNoteTranscriptSource(note.id).model, "parakeet");
});

test("another model, or text from before recording, marks the transcript mixed", (t) => {
  const db = setup(t);
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.recordLiveTranscriptSource(note.id, { engine: "local:nvidia", model: "parakeet" });
  const switched = db.recordLiveTranscriptSource(note.id, { engine: "openwhispr", model: "x" });
  assert.equal(switched.engine, "openwhispr");
  assert.equal(switched.mixed, 1);

  const older = db.saveNote("Old meeting", "", "meeting").note;
  db.updateNote(older.id, { transcript: '[{"text":"hello"}]' });
  assert.equal(
    db.recordLiveTranscriptSource(older.id, { engine: "openwhispr", model: null }).mixed,
    1
  );
});

test("a re-transcription replaces the source and keeps the summary hash to compare", (t) => {
  const db = setup(t);
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.recordLiveTranscriptSource(note.id, { engine: "local:nvidia", model: "parakeet" });
  db.recordLiveTranscriptSource(note.id, { engine: "openwhispr", model: null });

  const row = db.recordRetranscribedSource(note.id, {
    engine: "byok:groq",
    model: "whisper-large-v3",
    staleSummaryHash: "hash-1",
  });
  assert.equal(row.source, "retranscribed");
  assert.equal(row.mixed, 0);
  assert.equal(row.stale_summary_hash, "hash-1");

  // A later live session keeps the hash and notes the mix.
  const live = db.recordLiveTranscriptSource(note.id, {
    engine: "byok:groq",
    model: "whisper-large-v3",
  });
  assert.equal(live.mixed, 1);
  assert.equal(live.stale_summary_hash, "hash-1");

  assert.deepEqual(db.clearStaleSummaryHash(note.id), { success: true });
  assert.equal(db.getNoteTranscriptSource(note.id).stale_summary_hash, null);
});

test("transcript sources are scoped to the account and go with the note", (t) => {
  const db = setup(t, "account-a");
  if (!db) return;
  const note = db.saveNote("Weekly sync", "", "meeting").note;
  db.recordLiveTranscriptSource(note.id, { engine: "openwhispr", model: null });

  db.setActiveAccountId("account-b");
  assert.equal(db.getNoteTranscriptSource(note.id), null);
  assert.equal(db.recordRetranscribedSource(note.id, { engine: "openwhispr" }), null);
  assert.deepEqual(db.clearStaleSummaryHash(note.id), { success: false });

  db.setActiveAccountId("account-a");
  db.hardDeleteNote(note.id);
  assert.equal(db.getNoteTranscriptSource(note.id), null);
  assert.equal(db.recordLiveTranscriptSource(note.id, { engine: "openwhispr" }), null);
});
