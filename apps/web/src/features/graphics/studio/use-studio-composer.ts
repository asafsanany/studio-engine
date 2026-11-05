import { DEFAULT_EFFORT, type Effort, type GraphicDetail } from '@studio/shared';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useCreateGraphic, useGraphicVoice, useSendGraphicMessage } from '@/data';
import { useVoiceRecorder } from '@/features/review/use-voice-recorder';
import type { RecorderSnapshot } from '@/features/review/voice-recorder';
import { submitMessage } from './studio-actions';
import {
  addAttachments,
  appendVoiceText,
  makingVersionOf,
  type SendState,
  sendState,
} from './studio-logic';
import { micAction, voiceToText } from './voice-text';

/** Everything the composer shows and does: the draft, the files, the effort, Send and the mic. */
export interface ComposerController {
  draft: string;
  setDraft: (text: string) => void;
  files: readonly File[];
  addFiles: (picked: Iterable<File>) => void;
  removeFile: (index: number) => void;
  effort: Effort;
  setEffort: (level: Effort) => void;
  /** Why the last Send or the last file was refused, in the server's words. */
  notice: string | null;
  /** The message is on its way. */
  sending: boolean;
  send: SendState;
  /** Sends the message (does nothing while Send is off). */
  submit: () => void;
  voice: {
    snapshot: RecorderSnapshot;
    /** The mic button: starts, stops or drops the recording. */
    toggle: () => void;
    /** Esc: drops a recording that is starting or running. Answers whether it did. */
    cancel: () => boolean;
    retry: () => void;
    discard: () => void;
  };
}

interface ComposerInput {
  /** The graphic the message goes to; `undefined` on /graphics/new, where Send creates it. */
  graphic: GraphicDetail | undefined;
  offline: boolean;
}

/**
 * The composer's state for a graphic's page. Send posts the message (the first one of
 * /graphics/new creates the graphic and replaces the address with /graphics/<id>), keeps the draft
 * and the files when the engine refuses, and clears them when it takes the message. The mic types
 * a voice note out into the draft.
 */
export function useStudioComposer({ graphic, offline }: ComposerInput): ComposerController {
  const navigate = useNavigate();
  const create = useCreateGraphic();
  const sendMessage = useSendGraphicMessage();
  const transcribe = useGraphicVoice();

  const [draft, setDraftText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [effort, setEffort] = useState<Effort>(DEFAULT_EFFORT);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** A second Send before the first one has been answered. */
  const inFlight = useRef(false);

  const { recorder, snapshot } = useVoiceRecorder(
    voiceToText(transcribe.mutateAsync, (said) =>
      setDraftText((current) => appendVoiceText(current, said)),
    ),
  );

  const state = sendState({
    draft,
    files,
    makingVersion: makingVersionOf(graphic),
    offline,
    sending,
    recorderBusy: snapshot.phase !== 'idle',
  });

  async function submit() {
    if (!state.enabled || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setNotice(null);
    const result = await submitMessage(
      { graphicId: graphic?.id, text: draft, files, effort },
      { create: create.mutateAsync, send: sendMessage.mutateAsync },
    );
    inFlight.current = false;
    setSending(false);
    if (!result.ok) {
      setNotice(result.error);
      return;
    }
    setDraftText('');
    setFiles([]);
    if (result.created) {
      void navigate({ to: '/graphics/$id', params: { id: result.detail.id }, replace: true });
    }
  }

  return {
    draft,
    setDraft: (text) => {
      setDraftText(text);
      setNotice(null);
      recorder.clearError();
    },
    files,
    addFiles: (picked) => {
      const added = addAttachments(files, [...picked]);
      setFiles(added.files);
      setNotice(added.error);
    },
    removeFile: (index) => {
      setFiles((current) => current.filter((_, at) => at !== index));
      setNotice(null);
    },
    effort,
    setEffort,
    notice,
    sending,
    send: state,
    submit: () => void submit(),
    voice: {
      snapshot,
      toggle: () => {
        switch (micAction(snapshot)) {
          case 'start':
            setNotice(null);
            void recorder.start(0);
            break;
          case 'stop':
            recorder.stop();
            break;
          case 'cancel':
            recorder.cancel();
            break;
          case 'none':
            break;
        }
      },
      cancel: () => {
        if (snapshot.phase !== 'starting' && snapshot.phase !== 'recording') return false;
        recorder.cancel();
        return true;
      },
      retry: () => void recorder.retry(),
      discard: () => recorder.discard(),
    },
  };
}
