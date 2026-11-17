// FORK: the stored meeting audio of a note, as a pill beside the record button
// in the same style: its length at rest, the progress of a background
// re-transcription while one runs. Its menu says which model wrote the
// transcript and offers re-transcribe, show in folder and export
// (specs/meeting-audio-recording/design.md §3.4-3.5). Renders nothing for a
// note without recordings, or while the note is recording.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { AudioLines, Download, FolderOpen, Loader2, RefreshCw, X } from "../icons";
import { cn } from "../lib/utils";
import MeetingRetranscribeDialog from "./MeetingRetranscribeDialog";
import { useNoteTranscriptSource, useTranscriptSourceText } from "./useTranscriptModelLabel";
import {
  cancelRetranscription,
  useMeetingRetranscribeStore,
} from "../../stores/meetingRetranscribeStore";
import { formatRecordingDuration } from "../../utils/transcriptSource";
import type { NoteRecording } from "../../types/electron";

interface NoteRecordingsMenuProps {
  noteId: number;
  /** The note is recording: the pill comes back once it stops. */
  hidden?: boolean;
  disabled?: boolean;
  className?: string;
}

export default function NoteRecordingsMenu({
  noteId,
  hidden,
  disabled,
  className,
}: NoteRecordingsMenuProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [recordings, setRecordings] = useState<NoteRecording[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const job = useMeetingRetranscribeStore((s) => s.job);
  const source = useNoteTranscriptSource(noteId);
  const sourceText = useTranscriptSourceText(source);

  const refresh = useCallback(() => {
    window.electronAPI
      ?.getNoteRecordings?.(noteId)
      .then((rows) => setRecordings(Array.isArray(rows) ? rows : []))
      .catch(() => setRecordings([]));
  }, [noteId]);

  useEffect(() => {
    refresh();
    return window.electronAPI?.onNoteRecordingsChanged?.((payload) => {
      if (payload?.noteId === noteId) refresh();
    });
  }, [noteId, refresh]);

  if (hidden || recordings.length === 0) return null;

  const k = "notes.recordings";
  const running = job?.noteId === noteId;
  const otherRunning = Boolean(job) && !running;
  const progress = running ? job.progress : null;
  const progressText =
    progress?.phase === "transcribing"
      ? t(`${k}.retranscribe.transcribing`, { done: progress.done, total: progress.total })
      : t(`${k}.retranscribe.analyzing`);
  const totalDurationMs = recordings.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);

  const handleExport = async () => {
    const result = await window.electronAPI?.exportNoteRecordings?.(noteId).catch(() => null);
    if (!result || result.cancelled) return;
    toast(
      result.success
        ? { title: t(`${k}.exported`, { count: result.count ?? 1 }), variant: "success" }
        : { title: t(`${k}.exportFailed`), variant: "destructive" }
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={running ? progressText : t(`${k}.menu`)}
            title={running ? progressText : t(`${k}.menu`)}
            className={cn(
              "inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full border ps-2.5 pe-3 text-xs font-medium tabular-nums transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              "disabled:cursor-not-allowed disabled:opacity-50",
              running
                ? "border-primary/25 bg-surface-2/95 text-foreground/85 shadow-(--shadow-glass) hover:border-primary/40"
                : "border-border/70 text-foreground/70 hover:bg-foreground/5",
              className
            )}
          >
            {running ? (
              <>
                <Loader2 size={13} className="animate-spin text-primary" />
                {progress?.phase === "transcribing"
                  ? `${progress.done}/${progress.total}`
                  : t(`${k}.pill.analyzing`)}
              </>
            ) : (
              <>
                <AudioLines size={13} />
                {formatRecordingDuration(totalDurationMs)}
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="space-y-0.5 font-normal">
            <span className="block text-xs font-medium text-foreground">
              {sourceText
                ? t(`${k}.source.title`, { model: sourceText.model })
                : t(`${k}.source.notRecorded`)}
            </span>
            {sourceText && (
              <span className="block text-[11px] text-muted-foreground">{sourceText.detail}</span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {running ? (
            <>
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                {progressText}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => cancelRetranscription(noteId)}>
                <X size={14} />
                {t(`${k}.retranscribe.cancelRun`)}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              disabled={otherRunning}
              title={otherRunning ? t(`${k}.retranscribe.busyElsewhere`) : undefined}
              onSelect={() => setDialogOpen(true)}
            >
              <RefreshCw size={14} />
              {t(`${k}.retranscribe.menuItem`)}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void window.electronAPI?.showNoteRecordingInFolder?.(recordings[0].id)}
          >
            <FolderOpen size={14} />
            {t(`${k}.showInFolder`)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleExport()}>
            <Download size={14} />
            {t(`${k}.export`)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MeetingRetranscribeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        noteId={noteId}
        recordings={recordings}
        currentModel={sourceText?.model ?? null}
      />
    </>
  );
}
