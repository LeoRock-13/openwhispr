# Fork LeoRock-13/openwhispr

Versione personale di OpenWhispr, con auto-update dalle release di questo fork.

## Branch e remote

- `main`: copia pulita dell'originale. Non ci si committa sopra.
- `custom`: le mie modifiche. Le release si fanno da qui.
- `origin` = `LeoRock-13/openwhispr`, `upstream` = `OpenWhispr/openwhispr`.

## Cosa differisce dall'originale (cercare `FORK:`)

- `src/updater.js`: l'auto-update legge le release di `LeoRock-13/openwhispr`.
- `electron-builder.fork-win.json`: build Windows non firmata, caricata sul fork.
- `.github/workflows/fork-release.yml`: workflow manuale. Crea la release in bozza, ci carica
  installer + `latest.yml` + blockmap, controlla che ci siano tutti e poi la pubblica. Se la
  versione è già pubblicata si ferma subito: va alzata la versione.
- `specs/`: spec, design e task delle modifiche del fork.
- **Audio dei meeting** (`specs/meeting-audio-recording/`): ogni meeting salva l'audio
  (WebM/Opus stereo: mic a sinistra, sistema a destra) in `userData/audio/meetings/`, con la stessa
  conservazione dell'audio delle dettature. Dalla nota, il menu con l'icona onda serve per
  ritrascrivere con un altro modello, mostrare nella cartella o esportare.
  - Moduli nuovi: `src/helpers/meetingAudioRecorder.js`, `meetingRecordingStorage.js`,
    `meetingRetranscribeChunks.js`, `meetingTranscriptSource.js`,
    `src/services/meetingRetranscription.ts`, `src/stores/meetingRetranscribeStore.ts`,
    `src/utils/meetingRetranscribe{Segments,Models}.ts`, `src/utils/transcriptSource.ts`,
    `src/components/notes/{NoteRecordingsMenu,MeetingRetranscribeDialog,MeetingRetranscribeToastListener}.tsx`,
    `src/components/notes/useTranscriptModelLabel.ts`.
  - Agganci in file upstream (possibili conflitti al merge): `ipcHandlers.js` (blocchi `FORK:`),
    `database.js` (tabelle `note_recordings`, `note_transcript_sources`), `ffmpegUtils.js`, `retentionSettings.js`,
    `preload.js`, `types/electron.ts`, `settingsStore.ts`, `useSettings.ts`, `NoteEditor.tsx`,
    `SettingsPage.tsx`, `MeetingSettings.tsx`, `ControlPanel.tsx`, `locales/*/translation.json`.
- Fix di un bug upstream, proponibile a loro: il PCM temporaneo della diarizzazione non veniva
  cancellato quando la diarizzazione è disattivata (`_startOrSkipDiarization`).

## Numero di versione

L'app si aggiorna solo se la release ha una versione più alta di quella installata.
Schema: `patch = patch ufficiale × 100 + numero mio`.

| Ufficiale | Mie release           |
| --------- | --------------------- |
| 1.12.0    | 1.12.1, 1.12.2, …     |
| 1.12.1    | 1.12.101, 1.12.102, … |
| 1.13.0    | 1.13.1, 1.13.2, …     |

Per cambiarla: `npm version 1.12.2 --no-git-tag-version --ignore-scripts`

## Fare una release

1. Su `custom`, alzare la versione (vedi sopra) e fare commit + push.
2. GitHub → Actions → **Fork Release** → _Run workflow_ sul branch `custom`.
3. Dopo ~20-30 minuti c'è la release `v<versione>`. L'app installata la trova da sola.

## Prendere gli aggiornamenti ufficiali

```bash
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
git switch custom && git merge main
```

Se c'è conflitto su `version` in `package.json`/`package-lock.json`, tenere la versione
ufficiale e poi rialzarla con lo schema sopra. Poi fare una release.

## Limiti della build del fork

- Non è firmata: al primo install SmartScreen avvisa ("Ulteriori informazioni" → "Esegui comunque").
- Le integrazioni che usano le chiavi OAuth dell'originale (Google/Microsoft Calendar, Gmail,
  Slack, Linear, GitHub) non sono incluse. Si possono aggiungere come secret del repo e
  scriverle nello step "Create runtime env" del workflow.
- Gli altri workflow ereditati (Build and Notarize, Release, canary…) nel fork falliscono
  per mancanza dei secret: conviene disattivarli da Actions.
