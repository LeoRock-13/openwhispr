# Design: salvataggio e ritrascrizione dell'audio dei meeting

Stato: **APPROVATO** con revisione strutturale del 2026-11-17 (§0). Riferimento: [spec.md](spec.md).
"ipc" = `src/helpers/ipcHandlers.js`; i numeri di riga sono quelli del 2026-11-17 (v1.12.0).

## 0. Revisione strutturale: coerenza con il codice esistente

Convenzioni verificate nel repo e applicate al design:

| Tema                  | Convenzione esistente                                                                                                                                                                          | Conseguenza sul design                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Moduli main           | CommonJS `.js` in `src/helpers/`, classi gestore istanziate in `IPCHandlers` (`this.audioStorageManager = new AudioStorageManager()`, ipc:879)                                                 | `MeetingRecordingStorage` è una classe, istanziata accanto ad `audioStorageManager`. Le funzioni pure stanno in moduli separati, testabili senza Electron.                                                                                             |
| Codice renderer       | Orchestrazione dei flussi lunghi nel renderer (`UploadAudioView` → `transcribeFileWithSpeakers` → IPC)                                                                                         | La ritrascrizione è orchestrata dal renderer (`src/services/meetingRetranscription.ts`), con lo stesso schema dell'upload.                                                                                                                             |
| Tabelle per nota      | `speaker_mappings`, `note_speaker_embeddings`: `note_id INTEGER … REFERENCES notes(id) ON DELETE CASCADE`, **senza** `account_id` (scope tramite la nota); foreign key attive (better-sqlite3) | `note_recordings` segue lo stesso schema. La CASCADE copre **tutti** i 9 punti che cancellano note (singola, cartella, spazio, account, sync…), senza agganci in `deleteNoteInternal`. I file rimasti senza riga li elimina la riconciliazione (§2.6). |
| Diarizzazione di file | IPC pubblico `diarize-audio-file` (ipc:5658) con policy, impostazioni, clustering e annullamento per `requestId`                                                                               | La ritrascrizione **chiama quell'IPC** sul canale sistema invece di riscriverne la logica nel main.                                                                                                                                                    |
| Impostazioni → main   | Un solo canale `retention-settings-changed` (`retentionSettings.js` + `useSettings.ts:202`)                                                                                                    | `saveMeetingAudio` è un campo in più di quel canale (è un'impostazione di conservazione), non un IPC nuovo.                                                                                                                                            |
| Temp                  | `getSafeTempDir()` + prefissi `ow-*` + sweep 24 h (`urlAudioDownloader.sweepStaleTempArtifacts`)                                                                                               | I file di lavoro della ritrascrizione sono in `getSafeTempDir()/ow-retx-*`. Il prefisso va aggiunto allo sweep e all'allowlist di `delete-temp-file`.                                                                                                  |
| Test                  | `node --import tsx --test "test/**/*.test.js"`; DB testato con il `DatabaseManager` reale e uno stub di `electron` (`noteFilesDatabase.test.js`); ffmpeg con `harness/wavFixtures`             | Stessi pattern: `test/helpers/noteRecordingsDatabase.test.js`, `test/helpers/ffmpegUtils.test.js` (estensione), `test/helpers/meetingAudioRecorder.test.js`, …                                                                                         |
| i18n                  | `npm run i18n:check` in CI su 11 locale                                                                                                                                                        | Chiavi in tutte le lingue.                                                                                                                                                                                                                             |

## 1. Visione d'insieme

```
 REGISTRAZIONE (main)                                  RITRASCRIZIONE (renderer orchestra, main lavora su file)

 sendMeetingAudio(buf, source, synthetic, capturedAt)   NoteEditor ─ "Ritrascrivi…" ─ dialog (modello, conferma)
        │  (ipc:11982, unico imbuto mic+system)               │
        ▼                                                     ▼
 MeetingAudioRecorder.write()                           1. IPC meeting-recordings-split(noteId)
   audio/meetings/.partial/<sessionId>/                      ffmpeg: stereo → mic.wav + system.wav (16 kHz)
     meta.json, mic.pcm, system.pcm  (allineati)          2. IPC esistente diarize-audio-file(system.wav)
        │ stop                                                 → turni di parlato con speaker
        ▼                                                 3. IPC meeting-recordings-build-chunks(turni)
                                                             mic: frasi per energia; system: turni
                                                             → chunk WAV (≤30 s) con {source, startMs, speaker}
 finalize(): ffmpeg 2×s16le → WebM/Opus stereo                │
   audio/meetings/OpenWhispr-Meeting-<data>-<sid>.webm        ▼
   + riga in note_recordings                            renderer: per ogni chunk transcribeFile(cfg scelto)
                                                          (riusa TUTTO il routing: cloud, BYOK, locale, managed)
 avvio app: recoverPartials() (crash / chiusura)          avanzamento = chunk fatti / totali, annulla
                                                          → TranscriptSegment[] ordinati → updateNote(transcript)
```

Scelte chiave:

- **Un modulo nuovo per ogni responsabilità**, con agganci di poche righe in `ipcHandlers.js`
  (file da 16k righe che cambia a ogni release upstream: meno righe toccate = meno conflitti).
- **La registrazione si aggancia all'imbuto unico** `sendMeetingAudio`, quindi copre ogni
  percorso di cattura (renderer, WASAPI, loopback, tap macOS) e ogni provider.
- **La ritrascrizione si fa a chunk con tempo noto.** Cloud OpenWhispr e modelli locali
  restituiscono solo testo, senza timestamp: se trascrivessimo il canale intero non sapremmo
  dove mettere le frasi rispetto all'altro canale. Tagliando prima l'audio in frasi/turni con
  tempo di inizio noto, ogni provider va bene e l'avanzamento è reale.

## 2. Registrazione

### 2.1 `src/helpers/meetingAudioRecorder.js` (nuovo)

Una istanza per sessione, creata da una factory `createMeetingAudioRecorder({ baseDir, sessionId, noteId, accountId, startedAt })`.

- **Dove scrive durante la sessione**: `userData/audio/meetings/.partial/<sessionId>/`
  con `meta.json` (`{ sessionId, noteId, accountId, startedAt, version: 1 }`), `mic.pcm`, `system.pcm`.
  In `userData`, non in tmp: sopravvive a crash e chiusure e non viene pulito dal sistema.
- **`write(source, buffer, { capturedAt, synthetic })`**, allineamento sul tempo:
  - Ogni canale tiene `samplesWritten`.
  - Tempo del chunk: `t = capturedAt ?? Date.now()`. Il chunk "inizia" a `t - durata(chunk)`,
    perché `Date.now()` all'arrivo indica la fine.
  - Posizione attesa: `expected = (inizio - startedAt) × 24 000`.
  - Se `expected - samplesWritten > 250 ms` → prima scrive zeri fino a `expected`. Copre il
    canale sistema che parte dopo il mic e i buchi quando l'helper WASAPI si riavvia.
  - Se il canale è "avanti" non taglia mai: il jitter IPC non deve creare tagli udibili.
  - I chunk `synthetic` (silenzio di recupero del tap macOS) si scrivono così come sono.
  - Scrittura tramite `fs.WriteStream` (nessun buffer in RAM oltre a quello dello stream).
- **`finalize()`** → `Promise<{ filePath, durationMs, sizeBytes } | null>`:
  1. chiude gli stream; porta il file più corto alla stessa lunghezza con zeri;
  2. se entrambi sono vuoti o sotto 1 s → scarta tutto e restituisce `null`;
  3. ffmpeg (nuovo helper `encodeStereoPcmToOpus` in `ffmpegUtils.js`):
     `-f s16le -ar 24000 -ac 1 -i mic.pcm -f s16le -ar 24000 -ac 1 -i system.pcm
 -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]"
 -c:a libopus -b:a 48k -application voip out.webm` (circa 21 MB/ora);
  4. sposta il risultato in `audio/meetings/OpenWhispr-Meeting-YYYY-MM-DD-HH-MM-SS-<sessionId>.webm`;
  5. scrive la riga in `note_recordings` e cancella la cartella `.partial`.
     Se ffmpeg fallisce, la cartella `.partial` **resta** e verrà ritentata al prossimo avvio:
     mai perdere l'audio grezzo per un errore di codifica.
- **`discard()`**: chiude e cancella `.partial/<sessionId>` (avvio fallito o annullato).

### 2.2 Agganci in `ipcHandlers.js`

| Punto                                                                  | Riga circa   | Aggancio                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startMeetingTranscription`, dopo `meetingStartedAt` / `meetingNoteId` | 11822, 11867 | `meetingAudioRecorder = this.meetingRecordings.startSession({ sessionId: recordingSessionId, noteId, startedAt })`: restituisce `null` se il salvataggio non è permesso (§2.4) |
| `sendMeetingAudio`, subito dopo il controllo di policy                 | 11991        | `meetingAudioRecorder?.write(source, outboundBuffer, { capturedAt, synthetic })`: audio **grezzo**, prima di AEC/gate (D1)                                                     |
| `stopMeetingTranscription`, prima di `captureMeetingDiarizationState`  | 12342, 12376 | `const rec = meetingAudioRecorder; meetingAudioRecorder = null; void rec?.finalize().then(notify)`: in background, lo stop non aspetta la codifica                             |
| `resetMeetingLocalState` / `rollbackMeetingTranscriptionStart`         | 11197, 11489 | `meetingAudioRecorder?.discard(); meetingAudioRecorder = null`                                                                                                                 |
| setup IPC (accanto a `sweepStaleTempArtifacts`)                        | 4704         | `this.meetingRecordings.recoverPartials()` in background                                                                                                                       |

Il chunk renderer ancora in volo dopo lo stop trova `meetingAudioRecorder === null` e viene ignorato.
Alla chiusura dell'app (`before-quit` → `performSyncTeardown`, main.js:2310) lo stop del meeting non
viene chiamato: la cartella `.partial` resta e `recoverPartials()` la codifica al prossimo avvio.

### 2.3 `src/helpers/meetingRecordingStorage.js` (nuovo)

Classe `MeetingRecordingStorage({ getDatabase, getRetentionSettings })`, istanziata in `IPCHandlers`
accanto ad `audioStorageManager` (ipc:879). È la facciata usata da ipcHandlers e dalla UI, così
ipcHandlers resta sottile. La directory è `userData/audio/meetings/`: il codice della dettatura
legge `audio/` senza ricorsione, quindi non la vede.

- `startSession(...)` → recorder o `null` (gate §2.4).
- `recoverPartials()`: per ogni `.partial/*/meta.json` → `finalize()`; senza `meta.json`
  valido o più vecchio di 7 giorni senza audio → cancella.
- `listForNote(noteId)`, `getFilePath(recordingId)`, `deleteForNote(noteId)`, `deleteRecording(id)`.
- `cleanupExpired(retentionDays)`: cancella file + righe con `started_at` più vecchio del limite.
- `reconcileOrphans()`: cancella i file `.webm` di `audio/meetings/` che non hanno più una riga
  (la riga sparisce per CASCADE quando la nota viene eliminata, da qualsiasi percorso).
- `getStorageUsage()` → `{ fileCount, totalBytes }` dell'account attivo (JOIN su `notes`).
- `deleteAll()` → cancella le registrazioni dell'account attivo (pulsante in Impostazioni).

### 2.4 Quando si registra (gate)

Si registra solo se **tutto** è vero (stessa logica della dettatura, `audioManager.js:836`):

- `_retentionSettingsSynced` (le impostazioni reali sono arrivate dal renderer);
- `dataRetentionEnabled` (cronologia locale attiva, già con la policy aziendale applicata);
- `audioRetentionDays > 0` (0 = "non salvare audio", già oggi per la dettatura);
- nuova impostazione `saveMeetingAudio` (default `true`).

Le prime tre arrivano già nel main (`this._retentionSettings`). `saveMeetingAudio` diventa un
campo in più dello stesso canale: `DEFAULT_RETENTION_SETTINGS` e `applyRetentionSettings` in
`retentionSettings.js` (+ test esistente `retentionSettings.test.js`), e `syncRetentionSettings` in
`useSettings.ts`. Il default `true` vale anche per un renderer che non manda il campo.

### 2.5 Database (`database.js`)

Nuova tabella, creata con il pattern esistente `CREATE TABLE IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS note_recordings (
  id          TEXT PRIMARY KEY,          -- sessionId del meeting
  note_id     INTEGER NOT NULL,
  file_name   TEXT NOT NULL UNIQUE,      -- solo nome file, relativo a audio/meetings/
  started_at  INTEGER NOT NULL,          -- epoch ms, base dei timestamp dei segmenti
  duration_ms INTEGER,
  size_bytes  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_note_recordings_note ON note_recordings(note_id, started_at);
```

Come `speaker_mappings` / `note_speaker_embeddings`: niente `account_id`, lo scope passa dalla nota
(`JOIN notes n` + `_accountScopeCondition("n")`).

Metodi:

- `addNoteRecording({ id, noteId, fileName, startedAt, durationMs, sizeBytes })`: idempotente
  (`INSERT OR REPLACE`), perché il recupero all'avvio può ritentare una sessione;
- `getNoteRecordings(noteId)`: solo se la nota è visibile all'account attivo, ordinate per `started_at`;
- `getNoteRecording(id)` (con scope), `getNoteRecordingById(id)` (senza scope, solo per lo storage),
  `deleteNoteRecording(id)`;
- `getExpiredNoteRecordings(cutoffMs)`: **tutti gli account**, come la pulizia audio della
  dettatura ("device-wide", `audioStorage.js:141`);
- `getAllNoteRecordingFileNames()` per la riconciliazione;
- `getVisibleNoteRecordings()`: registrazioni dell'account attivo, per l'uso disco e "elimina tutto".

**Cancellazione della nota**: nessun aggancio. La `ON DELETE CASCADE` rimuove le righe in tutti i
percorsi di hard delete. Il tombstone di sync (`deleted_at`) non elimina la riga, quindi l'audio resta
finché la nota non viene davvero eliminata (anche `db-restore-note-after-denied-delete` funziona).
I file senza riga li cancella `reconcileOrphans()`.

### 2.6 Conservazione

- `_runRetentionCleanup` (ipc:1709) → anche `this.meetingRecordings.cleanupExpired(days)`
  quando `audioRetentionDays > 0`, e `reconcileOrphans()` **sempre**. Stessa cadenza della dettatura
  (ogni 6 h e al cambio impostazioni). `reconcileOrphans()` gira anche all'avvio, dopo `recoverPartials()`.
- Impostazioni → sezione "Conservazione audio" (SettingsPage.tsx ~4493): una riga in più con
  "Audio dei meeting: N file, X MB" e il pulsante "Elimina audio dei meeting". "Elimina audio
  della cronologia" esistente resta solo per le dettature.

## 3. Ritrascrizione

### 3.1 Lavoro sui file nel main

Moduli: `src/helpers/meetingRetranscribeChunks.js` (funzioni pure: `segmentBySilence`,
`mergeSpeakerTurns`, `planChunks`) e i metodi di `MeetingRecordingStorage` che usano ffmpeg e il filesystem.

1. **IPC `meeting-recordings-split(noteId, { requestId })`** → `{ jobDir, recordings: [{ id, startedAt, durationMs, micPath, systemPath }] }`.
   Separa i canali di ogni registrazione con ffmpeg (nuovo helper `extractChannelToWav(input, channel, out)`,
   `-af pan=mono|c0=c<n>`, 16 kHz mono s16) in `getSafeTempDir()/ow-retx-<requestId>/`. Questa
   directory è accettata da `resolveAllowedAudioPath` (ipc:1443), quindi `transcribeFile` e
   `diarize-audio-file` ci possono lavorare.
2. **Diarizzazione** (renderer → IPC esistente `diarize-audio-file(systemPath, { requestId })`):
   turni `[{start, end, speaker}]`. Rispetta già impostazioni e policy della diarizzazione e si
   annulla con lo stesso `requestId`. Se non è disponibile o restituisce errore → nessun turno.
3. **IPC `meeting-recordings-build-chunks({ jobDir, recordingId, systemTurns, requestId })`** → `chunks: [{ path, source, startMs, endMs, speaker? }]`.
   - mic → `segmentBySilence` (JS puro): finestre da 30 ms, soglia adattiva (percentile del rumore
     di fondo + margine), silenzio ≥ 600 ms chiude una frase, frasi sotto 400 ms scartate, oltre 30 s
     tagliate nel punto più silenzioso;
   - system → `mergeSpeakerTurns(systemTurns)`: turni dello stesso speaker con pausa sotto 1,5 s
     vengono uniti, fino a 30 s. Senza turni si usa `segmentBySilence`, senza speaker;
   - un WAV per chunk (`pcm16ToWav`, `src/utils/audioUtils`), con `startMs = startedAt + offset`
     (epoch ms, come i segmenti live).
4. **IPC `meeting-recordings-cleanup-job(jobDir)`**: il renderer lo chiama sempre a fine lavoro.
   Accetta solo directory `ow-retx-*` dentro `getSafeTempDir()`, con lo stesso controllo realpath
   di `delete-temp-file`. In più `ow-retx-` va aggiunto allo sweep dei temp oltre 24 h
   (`urlAudioDownloader.sweepStaleTempArtifacts`), per i casi di crash.

### 3.2 Trascrizione nel renderer: `src/services/meetingRetranscription.ts` (nuovo)

```ts
retranscribeMeetingNote(noteId, cfg: FileTranscriptionConfig, { onProgress, signal })
  → { segments: TranscriptSegment[] } | { cancelled } | { error }
```

- Fase "Analisi audio…" (avanzamento indeterminato): split → diarizzazione → build-chunks
  per ogni registrazione.
- Per ogni chunk chiama **`transcribeFile(chunk.path, cfg, false, { requestId, purpose: "retranscribe" })`**
  (`fileTranscription.ts:129`), quindi riusa tutto il routing esistente: OpenWhispr Cloud,
  BYOK, self-hosted, locale whisper/parakeet, enterprise managed, chiavi API, policy.
  Concorrenza: 1 per i modelli locali (un solo server whisper), 3 per quelli cloud.
- Avanzamento reale: `chunkFatti / chunkTotali`.
- Annullamento: `signal` → smette di lanciare chunk + `cancelUploadTranscription(requestId)`
  per quello in corso.
- Costruisce i segmenti:
  - mic → `{ text, source: "mic", timestamp: startMs, speaker: "you" }`
  - system → `{ text, source: "system", timestamp: startMs, speaker: "speaker_N" }` con N
    rinumerato per ordine di comparsa e continuo tra più registrazioni della stessa nota
  - testo vuoto → scartato; ordinati per `timestamp`.
- **Filtro eco**: il mic è grezzo, quindi senza cuffie contiene anche la voce degli altri presa
  dalle casse. Un chunk mic che si sovrappone nel tempo a un chunk sistema con testo molto simile
  viene scartato, con la stessa idea di `isEchoDuplicate` usata dalla diarizzazione (~ipc:16300).
  La logica va in un helper puro, testabile.
- Serializza con `serializeTranscriptSegments` e salva con `updateNote(noteId, { transcript })`
  **solo a successo completo**. Se fallisce o viene annullato, il trascritto originale non viene toccato (R5.6).
- Chunk falliti: se sono meno del 10% → si salva comunque e si mostra "N parti non trascritte";
  altrimenti errore e niente salvataggio.

### 3.3 Scelta del modello (D5)

- **Default**: il modello configurato per i **file caricati** (`selectResolvedUploadTranscription`,
  `settingsStore.ts:3188`). È il modello "a file" (batch), mentre quello dei meeting può essere
  streaming-only (Deepgram, AssemblyAI non hanno un percorso batch, `transcriptionRoute.ts:107`).
  L'etichetta mostra nome provider + modello, es. "Predefinito: Groq · whisper-large-v3".
- **Menu "Usa un altro modello"**: un `Select` compatto, non il `TranscriptionModelPicker` intero
  (troppo grande), con:
  - modelli locali installati (`listLocalTranscriptionModels`, ipc:1447);
  - i provider cloud BYOK con chiave API configurata e i loro modelli (`getTranscriptionProviders()`
    di ModelRegistry), esclusi quelli streaming-only;
  - OpenWhispr Cloud se l'utente ha fatto l'accesso.
- La scelta produce un `FileTranscriptionConfig` derivato dal default con i campi di provider/modello
  sovrascritti. **Non** modifica le impostazioni salvate. L'ultima scelta viene ricordata
  in `localStorage` per comodità.

### 3.4 UI

- **NoteEditor** (`NoteEditor.tsx` ~1390-1423, accanto a Share): pulsante icona "Audio" con menu,
  visibile solo se la nota ha registrazioni:
  - "Ritrascrivi…" → dialog;
  - "Mostra nella cartella" → `shell.showItemInFolder` del primo file;
  - "Esporta audio" → 1 registrazione: dialog "Salva con nome"; più registrazioni: scelta cartella,
    poi copia di tutte.
  - Disabilitato mentre la nota sta registrando.
- **Dialog di ritrascrizione** (`MeetingRetranscribeDialog.tsx`, nuovo):
  1. scelta modello (§3.3), durata totale dell'audio, avviso di sostituzione: "Il trascritto attuale
     sarà sostituito. Nomi degli speaker e correzioni fatte a mano andranno persi."
  2. "Ritrascrivi" → avanzamento ("Analisi audio…", poi "Trascrizione 12/48") con "Annulla";
  3. fine: toast di successo, oppure messaggio di errore; il trascritto originale resta intatto.
- **Impostazioni meeting** (`MeetingSettings.tsx`): interruttore "Salva audio dei meeting".
  Se la conservazione audio è a 0 o la cronologia locale è disattivata, l'interruttore è disabilitato e
  mostra il perché.
- **i18n**: chiavi sotto `notes.recordings.*` e `settings.meeting.saveAudio*` in **tutti gli 11**
  locale (`npm run i18n:check` lo richiede in CI): en e it tradotti, gli altri in inglese come ripiego.

## 4. Bug upstream da correggere insieme

`_startOrSkipDiarization` (~ipc:16306): con diarizzazione disattivata o non disponibile esce con
`sendUndiarized()` senza cancellare `ow-diarize-raw-*.pcm`. Inoltre quel PCM sta in `os.tmpdir()`,
mentre lo sweep dei vecchi temp guarda `getSafeTempDir()`, quindi può restare per sempre.
Fix: `fs.promises.unlink(rawPcmPath).catch(() => {})` prima del `return`.

## 5. Test (node --test, cartella `test/`)

- `meetingAudioRecorder`: allineamento (canale sistema in ritardo → zeri iniziali corretti; buco
  > 250 ms → riempito; jitter < 250 ms → nessun riempimento; canale avanti → nessun taglio),
  > finalize con canale vuoto, discard.
- `segmentBySilence`: frasi separate da silenzio, scarto frasi corte, taglio oltre 30 s.
- Unione dei turni di diarizzazione (stesso speaker, pausa, limite 30 s).
- Costruzione segmenti: ordinamento, rinumerazione speaker su più registrazioni, filtro eco, chunk vuoti.
- `database`: CRUD `note_recordings` + scope account (sul modello dei test DB esistenti).
- Codifica ffmpeg reale (pcm → webm stereo → estrazione canali) se ffmpeg-static è disponibile nei test.
- Prova manuale su Windows: meeting reale con Teams, chiusura dell'app a metà meeting (→ recupero),
  ritrascrizione con modello locale e con uno cloud.

## 6. Rischi e limiti noti

- **Eco nel mic grezzo** senza cuffie: il filtro eco mitiga; in futuro si può far passare il mic
  salvato nell'helper AEC già presente durante la ritrascrizione.
- **Allineamento**: precisione circa ±250 ms. Basta per ordinare le frasi, non per un mix
  sample-accurate (non serve).
- **Costo cloud**: più chunk vuol dire più richieste. Il prezzo dei provider è per durata, quindi
  il costo resta simile, ma possono scattare i rate limit. Concorrenza limitata a 3, con retry e backoff sui 429.
- **Spazio**: circa 21 MB/ora, con la conservazione della dettatura (default 30 giorni).
- **Conflitti di merge**: agganci limitati a circa 6 punti in ipcHandlers.js (più la registrazione dei
  nuovi IPC, raggruppati in un solo blocco), 1 in NoteEditor.tsx, 1 in SettingsPage.tsx,
  1 in MeetingSettings.tsx, poche righe in useSettings.ts / retentionSettings.js / database.js /
  preload.js / types/electron.ts, più le traduzioni.
