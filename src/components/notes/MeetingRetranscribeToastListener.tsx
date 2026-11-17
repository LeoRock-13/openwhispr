// FORK: reports background meeting re-transcriptions
// (specs/meeting-audio-recording/design.md §3.4). Headless; mounted once in
// the control panel so a run that ends while the user is elsewhere still shows.
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast, type ToastActionConfig } from "../ui/useToast";
import {
  consumeRetranscribeEvents,
  requestSummaryRegeneration,
  useMeetingRetranscribeStore,
  type RetranscribeEvent,
} from "../../stores/meetingRetranscribeStore";
import { getActiveNoteIdValue } from "../../stores/noteStore";

interface Props {
  onOpenNote: (noteId: number) => void;
}

export default function MeetingRetranscribeToastListener({ onOpenNote }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const eventCount = useMeetingRetranscribeStore((s) => s.events.length);

  const show = useCallback(
    (event: RetranscribeEvent) => {
      const k = "notes.recordings.retranscribe";
      const viewing = getActiveNoteIdValue() === event.noteId;
      const openAction: ToastActionConfig = {
        label: t(`${k}.openNote`),
        onClick: () => onOpenNote(event.noteId),
      };
      const titled = (text: string) => (event.noteTitle ? `${event.noteTitle} · ${text}` : text);

      if (event.kind === "error") {
        const message =
          event.reason === "noSpeech"
            ? t(`${k}.noSpeech`)
            : event.reason === "saveFailed"
              ? t(`${k}.saveFailed`)
              : event.reason === "changed"
                ? t(`${k}.changedDuringRun`)
                : t(`${k}.failed`, { error: event.error ?? "" });
        toast({
          title: t(`${k}.failedTitle`),
          description: titled(message),
          variant: "destructive",
          actions: viewing ? undefined : [openAction],
        });
        return;
      }

      const actions: ToastActionConfig[] = [];
      if (event.hasSummary) {
        actions.push({
          label: t(`${k}.regenerateSummary`),
          onClick: () => {
            requestSummaryRegeneration(event.noteId);
            if (!viewing) onOpenNote(event.noteId);
          },
        });
      } else if (!viewing) {
        actions.push(openAction);
      }
      toast({
        title: t(`${k}.done`),
        description: titled(
          event.failedChunks > 0
            ? t(`${k}.partial`, { count: event.failedChunks })
            : event.hasSummary
              ? t(`${k}.summaryOutdated`)
              : t(`${k}.doneDescription`)
        ),
        variant: "success",
        duration: event.hasSummary ? 12000 : undefined,
        actions: actions.length > 0 ? actions : undefined,
      });
    },
    [toast, t, onOpenNote]
  );

  // A run can end while the app is in the background: its toast waits for focus
  // instead of timing out unseen.
  useEffect(() => {
    const offerQueued = () => {
      if (useMeetingRetranscribeStore.getState().events.length === 0) return;
      if (document.hasFocus?.() ?? true) consumeRetranscribeEvents().forEach(show);
    };
    offerQueued();
    window.addEventListener("focus", offerQueued);
    return () => window.removeEventListener("focus", offerQueued);
  }, [eventCount, show]);

  return null;
}
