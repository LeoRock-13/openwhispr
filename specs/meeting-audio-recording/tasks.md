# Task: salvataggio e ritrascrizione dell'audio dei meeting

Riferimenti: [spec.md](spec.md), [design.md](design.md). Ogni task si chiude con i propri test verdi.
Ordine pensato perché ogni blocco sia verificabile da solo.

## A. Fondamenta

- [x] **A1** Bug upstream: cancellare `ow-diarize-raw-*.pcm` sul percorso "diarizzazione saltata"
      (design §4). Commit separato, così si può proporre anche upstream.
- [x] **A2** `database.js`: tabella `note_recordings` (FK CASCADE su `notes`) + metodi + test
      `test/helpers/noteRecordingsDatabase.test.js` (design §2.5).
- [x] **A3** `ffmpegUtils.js`: `encodeStereoPcmToOpus` ed `extractChannelToWav` + test con
      ffmpeg reale (design §2.1, §3.1).

## B. Registrazione

- [ ] **B1** `meetingAudioRecorder.js`: write con allineamento, finalize, discard + test (design §2.1).
- [ ] **B2** `meetingRecordingStorage.js`: startSession con gate, recoverPartials, list/delete,
      cleanupExpired, getStorageUsage + test (design §2.3, §2.4).
- [ ] **B3** Agganci in `ipcHandlers.js`: start, sendMeetingAudio, stop (2 rami), reset/rollback,
      recupero all'avvio, notifica `note-recordings-changed` (design §2.2).
- [ ] **B4** Impostazione `saveMeetingAudio`: settingsStore + campo nel sync `retention-settings-changed`
      (`retentionSettings.js` + test, `useSettings.ts`) + interruttore in MeetingSettings (design §2.4, §3.4).
- [ ] **B5** Conservazione e orfani: `cleanupExpired` + `reconcileOrphans` in `_runRetentionCleanup` e
      all'avvio, riga uso disco + "Elimina audio dei meeting" in Impostazioni (design §2.5, §2.6).
- [ ] **B6** Verifica manuale: meeting reale su Windows → file stereo corretto (mic a sinistra, sistema
      a destra, allineati); chiusura dell'app a metà meeting → recupero al riavvio.

## C. Accesso all'audio

- [ ] **C1** IPC + preload + tipi: `getNoteRecordings`, `showNoteRecordingInFolder`, `exportNoteRecordings`.
- [ ] **C2** NoteEditor: pulsante/menu "Audio" (Mostra nella cartella, Esporta) visibile solo con registrazioni.

## D. Ritrascrizione

- [ ] **D1** `meetingRetranscribeChunks.js`: `segmentBySilence`, `mergeSpeakerTurns`, `planChunks` (pure) + test (design §3.1).
- [ ] **D2** IPC `meeting-recordings-split` / `-build-chunks` / `-cleanup-job` + `ow-retx-` nello sweep
      dei temp e nell'allowlist (design §3.1).
- [ ] **D3** `meetingRetranscription.ts`: loop chunk su `transcribeFile`, concorrenza, avanzamento,
      annullamento, costruzione segmenti, filtro eco, salvataggio solo a successo + test sulle parti pure (design §3.2).
- [ ] **D4** Selettore compatto del modello + `FileTranscriptionConfig` derivato (design §3.3).
- [ ] **D5** `MeetingRetranscribeDialog.tsx` + voce "Ritrascrivi…" nel menu Audio (design §3.4).
- [ ] **D6** Verifica manuale: ritrascrizione di un meeting reale con modello locale e con uno cloud;
      annullamento a metà (trascritto originale intatto); nota con 2 sessioni.

## E. Chiusura

- [ ] **E1** i18n in tutti gli 11 locale + `npm run i18n:check`.
- [ ] **E2** `npm run lint`, typecheck, test completi.
- [ ] **E3** Aggiornare `FORK.md` (elenco modifiche del fork) e la versione (1.12.2), poi release.
