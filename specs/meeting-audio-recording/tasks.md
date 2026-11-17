# Task: salvataggio e ritrascrizione dell'audio dei meeting

Riferimenti: [spec.md](spec.md), [design.md](design.md). Ogni task si chiude con i propri test verdi.
Ordine pensato perché ogni blocco sia verificabile da solo.

Stato al 2026-11-17: sviluppo completato. Restano le verifiche manuali (B6, D6) e la release (E3).

## A. Fondamenta

- [x] **A1** Bug upstream: cancellare `ow-diarize-raw-*.pcm` sul percorso "diarizzazione saltata"
      (design §4). Commit separato, così si può proporre anche upstream.
- [x] **A2** `database.js`: tabella `note_recordings` (FK CASCADE su `notes`) + metodi + test
      `test/helpers/noteRecordingsDatabase.test.js` (design §2.5).
- [x] **A3** `ffmpegUtils.js`: `encodeStereoPcmToOpus` ed `extractChannelToWav` + test con
      ffmpeg reale (design §2.1, §3.1).

## B. Registrazione

- [x] **B1** `meetingAudioRecorder.js`: write con allineamento, close, discard, padding + test (design §2.1).
- [x] **B2** `meetingRecordingStorage.js`: startSession con gate, finalize, recoverPartials,
      list/delete, cleanupExpired, reconcileOrphans, getStorageUsage + test (design §2.3, §2.4).
- [x] **B3** Agganci in `ipcHandlers.js`: start, sendMeetingAudio, stop (anche in caso di errore),
      rollback, recupero all'avvio, notifica `note-recordings-changed` (design §2.2).
- [x] **B4** Impostazione `saveMeetingAudio`: settingsStore + campo nel sync `retention-settings-changed`
      (`retentionSettings.js` + `retentionSettingsMeetingAudio.test.js`, `useSettings.ts`) + interruttore
      in MeetingSettings (design §2.4, §3.4).
- [x] **B5** Conservazione e orfani: `cleanupExpired` + `reconcileOrphans` in `_runRetentionCleanup` e
      all'avvio, riga uso disco + "Elimina audio dei meeting" in Impostazioni (design §2.5, §2.6).
- [ ] **B6** Verifica manuale: meeting reale su Windows → file stereo corretto (mic a sinistra, sistema
      a destra, allineati); chiusura dell'app a metà meeting → recupero al riavvio.

## C. Accesso all'audio

- [x] **C1** IPC + preload + tipi: `getNoteRecordings`, `showNoteRecordingInFolder`,
      `exportNoteRecordings`, uso disco, elimina tutto, evento `onNoteRecordingsChanged`.
- [x] **C2** `NoteRecordingsMenu` nel NoteEditor (Ritrascrivi, Mostra nella cartella, Esporta),
      visibile solo con registrazioni e disabilitato durante la registrazione.

## D. Ritrascrizione

- [x] **D1** `meetingRetranscribeChunks.js`: `segmentBySilence`, `mergeSpeakerTurns` (pure) + test (design §3.1).
- [x] **D2** IPC `meeting-recordings-split` / `-build-chunks` / `-cleanup-job`, sotto policy audio e
      registro di annullamento dell'upload, + sweep delle cartelle `ow-retx-*` (design §3.1).
- [x] **D3** `meetingRetranscription.ts` (loop chunk su `transcribeFile`, concorrenza, retry,
      avanzamento, annullamento, salvataggio solo a successo, pulizia nomi speaker) +
      `utils/meetingRetranscribeSegments.ts` (segmenti, filtro eco) + test (design §3.2).
- [x] **D4** `utils/meetingRetranscribeModels.ts`: opzioni del selettore + config derivata + test (design §3.3).
- [x] **D5** `MeetingRetranscribeDialog.tsx` + voce "Ritrascrivi…" nel menu Audio (design §3.4).
- [ ] **D6** Verifica manuale: ritrascrizione di un meeting reale con modello locale e con uno cloud;
      annullamento a metà (trascritto originale intatto); nota con 2 sessioni.

## E. Chiusura

- [x] **E1** i18n in tutti gli 11 locale (en/it tradotti, gli altri in inglese) + `npm run i18n:check`.
- [x] **E2** `npm run lint` (0 errori), `npm run typecheck`, Prettier, test mirati (non la suite completa).
- [ ] **E3** Release 1.12.2 (versione e FORK.md già aggiornati): dopo la revisione, push e workflow
      "Fork Release".
