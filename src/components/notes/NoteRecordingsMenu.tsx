// FORK: the stored meeting audio of a note: show it, export it, re-transcribe
// it (specs/meeting-audio-recording/design.md §3.4). Renders nothing for a
// note without recordings.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { AudioLines, Download, FolderOpen, RefreshCw } from "../icons";
import { cn } from "../lib/utils";
import MeetingRetranscribeDialog from "./MeetingRetranscribeDialog";
import type { NoteRecording } from "../../types/electron";

interface NoteRecordingsMenuProps {
  noteId: number;
  /** A note that is recording can't be re-transcribed or exported yet. */
  disabled?: boolean;
  className?: string;
}

export default function NoteRecordingsMenu({
  noteId,
  disabled,
  className,
}: NoteRecordingsMenuProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [recordings, setRecordings] = useState<NoteRecording[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);

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

  if (recordings.length === 0) return null;

  const handleExport = async () => {
    const result = await window.electronAPI?.exportNoteRecordings?.(noteId).catch(() => null);
    if (!result || result.cancelled) return;
    toast(
      result.success
        ? {
            title: t("notes.recordings.exported", { count: result.count ?? 1 }),
            variant: "success",
          }
        : { title: t("notes.recordings.exportFailed"), variant: "destructive" }
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("notes.recordings.menu")}
            title={t("notes.recordings.menu")}
            className={cn(
              "inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-border/70 text-foreground/70 transition-colors hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-50",
              className
            )}
          >
            <AudioLines size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
            <RefreshCw size={14} />
            {t("notes.recordings.retranscribe.menuItem")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void window.electronAPI?.showNoteRecordingInFolder?.(recordings[0].id)}
          >
            <FolderOpen size={14} />
            {t("notes.recordings.showInFolder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleExport()}>
            <Download size={14} />
            {t("notes.recordings.export")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MeetingRetranscribeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        noteId={noteId}
        recordings={recordings}
      />
    </>
  );
}
