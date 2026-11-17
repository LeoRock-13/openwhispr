// FORK: the "save meeting audio" switch rides the retention sync
// (specs/meeting-audio-recording/design.md §2.4).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RETENTION_SETTINGS,
  applyRetentionSettings,
} = require("../../src/helpers/retentionSettings");
const { meetingAudioRecordingAllowed } = require("../../src/helpers/meetingRecordingStorage");

test("the switch is absent until a renderer sends it, and recording stays allowed", () => {
  const { settings } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {});
  assert.equal("saveMeetingAudio" in settings, false);
  assert.equal(meetingAudioRecordingAllowed(settings, true), true);
});

test("turning the switch off and on counts as a change", () => {
  const off = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, { saveMeetingAudio: false });
  assert.equal(off.changed, true);
  assert.equal(off.settings.saveMeetingAudio, false);
  assert.equal(meetingAudioRecordingAllowed(off.settings, true), false);

  const same = applyRetentionSettings(off.settings, { saveMeetingAudio: false });
  assert.equal(same.changed, false);

  const on = applyRetentionSettings(off.settings, { saveMeetingAudio: true });
  assert.equal(on.changed, true);
  assert.equal(meetingAudioRecordingAllowed(on.settings, true), true);
});

test("a sync without the field keeps the last known value", () => {
  const off = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, { saveMeetingAudio: false });
  const { changed, settings } = applyRetentionSettings(off.settings, { audioRetentionDays: 30 });
  assert.equal(changed, false);
  assert.equal(settings.saveMeetingAudio, false);
});

test("a non-boolean value is ignored", () => {
  const { settings } = applyRetentionSettings(DEFAULT_RETENTION_SETTINGS, {
    saveMeetingAudio: "no",
  });
  assert.equal("saveMeetingAudio" in settings, false);
});
