# Spec: salvataggio e ritrascrizione dell'audio dei meeting

Stato: **APPROVATA** il 2026-11-17 (tutte le decisioni D1–D6 prese, vedi §6).

## 1. Problema

La dettatura salva l'audio di ogni registrazione (`userData/audio/*.webm`, `audioStorage.js`) e
permette di ritrascriverlo con il modello selezionato in quel momento (`retry-transcription`).
I meeting no: l'audio passa in streaming al provider (o a batch di 5 s per il locale) e viene
buttato. L'unica traccia su disco è un PCM temporaneo per la diarizzazione, che contiene solo
un canale e viene cancellato dopo.

Risultato: una trascrizione di meeting venuta male (modello veloce, rete instabile, lingua
sbagliata) non si può più migliorare.

## 2. Obiettivo

Salvare l'audio completo di ogni sessione di meeting, collegato alla nota, per poterlo
esportare e **ritrascrivere con un altro modello** (anche più lento e più preciso).

### Fuori scope (per ora)

- Player audio dentro l'app e sincronizzazione testo/audio.
- Sincronizzazione cloud dell'audio.
- Mobile.

## 3. Come funziona oggi (fatti dal codice)

- Tutto l'audio dei meeting, mic e sistema, da qualunque percorso di cattura (renderer,
  helper WASAPI, loopback, tap macOS), passa da **un solo punto nel main**:
  `sendMeetingAudio(buffer, source, synthetic, capturedAt)` in `ipcHandlers.js` (~r. 11982).
- Formato: PCM **24 kHz mono s16le**, `source` = `"mic"` | `"system"`, canali sempre separati.
- A quel punto l'audio è **grezzo**: prima di AEC, gate del microfono e holdback. Il mic pulito
  è quello che va al provider (`dispatchMeetingAudioBuffer`).
- Il microfono dei meeting, come quello della dettatura, è aperto con echoCancellation,
  noiseSuppression e autoGainControl disattivati (`meetingRecordingStore.ts:140`,
  `microphoneSelection.js:11`).
- Una sessione è legata a una nota tramite `noteId`. Una nota può avere **più sessioni** (il
  "riprendi registrazione" aggiunge alla stessa nota). Non c'è pausa.
- Il trascritto è salvato in `notes.transcript` come segmenti `{text, source, timestamp, speaker…}`.
- Riusabile: `transcribeFileWithSpeakers` (upload di file nelle note: trascrizione +
  diarizzazione), `retry-transcription` (dettatura), `convertRawPcmToWav`, ffmpeg.

## 4. Requisiti

### R1 — Registrazione

- R1.1 Ogni sessione di meeting salva l'audio completo di **entrambi i canali**, mic e sistema.
- R1.2 La scrittura avviene in streaming su disco durante la registrazione, non in RAM: un meeting
  di 2 ore non deve occupare memoria e un crash non deve far perdere tutto.
- R1.3 I due canali restano allineati nel tempo (stessa origine temporale, buchi riempiti di
  silenzio usando `capturedAt`), così si possono trascrivere separatamente e rimettere insieme.
- R1.4 Funziona con tutti i provider (streaming cloud, BYOK, locale) perché si aggancia a monte.
- R1.5 Il mic si salva **grezzo** (prima di AEC/gate), coerente con la dettatura. **[D1 deciso]**
- R1.6 A fine sessione l'audio viene compresso in **WebM/Opus** come la dettatura.
  Un solo file **stereo**: L = mic, R = sistema. **[D2 deciso]**
- R1.7 Se il salvataggio è disattivato da impostazione o da policy aziendale, non si scrive nulla.

### R2 — Collegamento alla nota

- R2.1 Ogni file è legato a `noteId` + id sessione. Una nota con 3 sessioni ha 3 registrazioni.
- R2.2 La nota sa di avere audio (es. tabella `note_recordings`), così la UI può mostrare le
  azioni senza scandire la cartella.
- R2.3 Cancellare la nota cancella anche le sue registrazioni.

### R3 — Conservazione e spazio

- R3.1 Conservazione: **stessa impostazione della dettatura** (`audioRetentionDays`, default
  30 gg). Alla scadenza si cancella l'audio, il trascritto resta. **[D3 deciso]**
- R3.2 I file dei meeting stanno in una sottocartella (`userData/audio/meetings/`). Il codice della
  dettatura legge solo `audio/` senza ricorsione e tratta ogni `.webm` come una dettatura: file
  mescolati verrebbero contati e cancellati nel modo sbagliato.
- R3.3 L'uso disco dei meeting compare in Impostazioni accanto a quello della dettatura.
- R3.4 Un interruttore "Salva audio dei meeting", attivo di default nel fork.

### R4 — Accesso all'audio

- R4.1 Dalla nota: "Mostra nella cartella" ed "Esporta audio".

### R5 — Ritrascrizione

- R5.1 Dalla nota: azione "Ritrascrivi", che usa il modello di trascrizione **scelto in quel
  momento** (come la dettatura), con un menu per sceglierne un altro al volo senza cambiare le
  Impostazioni. **[D5 deciso]**
- R5.2 La ritrascrizione rispetta i canali: il mic resta "Tu", il sistema viene diarizzato in
  speaker, come nel flusso originale.
- R5.3 Il nuovo trascritto **sostituisce** il vecchio dopo una conferma. La conferma avvisa che si
  perdono le modifiche fatte a mano sul trascritto (nomi degli speaker, testo corretto). **[D6 deciso]**
- R5.4 Le note scritte a mano nella nota (il corpo della nota) non vengono toccate, solo il trascritto.
- R5.5 Nota con più sessioni: si ritrascrivono tutte, in ordine, e i trascritti vengono concatenati.
- R5.6 Per i meeting lunghi l'avanzamento è visibile e si può annullare. Se si annulla o
  fallisce, il trascritto originale resta intatto.

## 5. Fasi

Un unico rilascio: salvataggio + ritrascrizione in-app (R1–R5). **[deciso]**

## 6. Decisioni

| #   | Domanda                                | Stato / proposta                                                       |
| --- | -------------------------------------- | ---------------------------------------------------------------------- |
| D1  | Mic grezzo o pulito?                   | ✅ **Grezzo**, come la dettatura.                                      |
| D2  | Layout del file                        | ✅ **Un file stereo** WebM/Opus (L = mic, R = sistema), ~15-30 MB/ora. |
| D3  | Conservazione                          | ✅ **Come la dettatura** (`audioRetentionDays`).                       |
| D4  | Player in-app                          | ✅ Rimandato.                                                          |
| D5  | Scelta del modello alla ritrascrizione | ✅ **Modello di Impostazioni + menu** per sceglierne un altro al volo. |
| D6  | Trascritto precedente                  | ✅ **Sostituito con conferma.**                                        |

## 7. Rischi / note per il merge con upstream

- `ipcHandlers.js` è enorme (16k+ righe) e cambia spesso upstream. La logica va in un modulo
  nuovo (es. `src/helpers/meetingAudioRecorder.js`) con **poche righe** di aggancio in
  `sendMeetingAudio` e nello stop, per ridurre i conflitti.
- Bug probabile già presente upstream: con diarizzazione disattivata il PCM temporaneo
  (`ow-diarize-raw-*.pcm`) non viene cancellato (`_startOrSkipDiarization`, ~r. 16306).
