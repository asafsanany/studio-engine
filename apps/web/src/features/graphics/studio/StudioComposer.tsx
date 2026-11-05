import { EFFORT_LABELS, type Effort, GRAPHIC_LIMITS } from '@studio/shared';
import { ArrowUp, ChevronDown, Loader2, Mic, Paperclip, X } from 'lucide-react';
import { type Ref, useRef } from 'react';
import { FileChip } from '@/components/chat/ChatRows';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { composerKeyAction } from '@/features/review/notes-logic';
import { cn } from '@/lib/utils';
import { ATTACH_ACCEPT, composerWords, EFFORT_CHOICES, micLabel, voiceLine } from './studio-logic';
import { COMPOSER_TEXT, VOICE_LINES } from './studio-text';
import { Tip } from './Tip';
import type { ComposerController } from './use-studio-composer';

interface StudioComposerProps {
  composer: ComposerController;
  /** The chat has messages: the box asks for a change instead of describing a graphic. */
  hasMessages: boolean;
  /** The engine cannot be reached: the box and its buttons wait. */
  offline: boolean;
  /** The textarea, so the page can focus it (after a starter filled it in). */
  textareaRef?: Ref<HTMLTextAreaElement>;
}

const VOICE_TONE = {
  recording: 'text-[#FCA5A5]',
  info: 'text-muted-foreground',
  error: 'text-[#FCA5A5]',
} as const;

/**
 * The composer under the chat (board GRStudio): the files waiting to be sent, the voice note's
 * line, a textarea in its own direction (Enter sends, Shift+Enter is a new line), and under it
 * Attach, the mic, Effort ▾ and Send. Typing stays possible while a version is being made; Send
 * waits, and says why.
 */
export function StudioComposer({
  composer,
  hasMessages,
  offline,
  textareaRef,
}: StudioComposerProps) {
  const picker = useRef<HTMLInputElement>(null);
  const { snapshot } = composer.voice;
  const words = composerWords(hasMessages);
  const line = voiceLine(snapshot);
  const recording = snapshot.phase === 'recording';
  const frozen = offline || composer.sending;
  const micBusy = snapshot.phase === 'saving' || snapshot.phase === 'failed';

  return (
    <div data-slot="studio-composer" className="flex-none px-4 pt-3 pb-4">
      {/* Esc throws a recording away from wherever the focus is: after a click on the mic it is on
          the mic button, not in the box. A menu that took the key (Effort ▾) has handled it already. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the key reaches this wrapper from the controls inside it */}
      <div
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented && composer.voice.cancel()) {
            event.preventDefault();
          }
        }}
        className={cn(
          'flex flex-col rounded-xl border bg-card transition-opacity duration-200 ease-in-out has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-[3px] has-[textarea:focus-visible]:ring-ring/35',
          offline && 'opacity-60',
        )}
      >
        {composer.files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {composer.files.map((file, index) => (
              <FileChip key={`${file.name}-${file.size}-${file.lastModified}`} name={file.name}>
                <button
                  type="button"
                  aria-label={`${COMPOSER_TEXT.remove} ${file.name}`}
                  onClick={() => composer.removeFile(index)}
                  disabled={frozen}
                  className="-mr-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors ease-in-out hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </FileChip>
            ))}
          </div>
        )}
        {line !== null && (
          <div
            role="status"
            data-slot="voice-line"
            data-phase={snapshot.phase}
            className={cn('flex items-center gap-2 px-3 pt-2.5 text-[13px]', VOICE_TONE[line.tone])}
          >
            {line.tone === 'recording' && (
              <span
                aria-hidden="true"
                className="size-2 animate-pulse rounded-full bg-[#EF4444] motion-reduce:animate-none"
              />
            )}
            {snapshot.phase === 'saving' && (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            )}
            <span className="min-w-0 flex-1 break-words">{line.text}</span>
            {snapshot.phase === 'failed' && (
              <>
                <Button type="button" variant="ghost" size="xs" onClick={composer.voice.discard}>
                  {VOICE_LINES.discard}
                </Button>
                <Button type="button" variant="outline" size="xs" onClick={composer.voice.retry}>
                  {VOICE_LINES.retry}
                </Button>
              </>
            )}
          </div>
        )}
        <Textarea
          ref={textareaRef}
          dir="auto"
          rows={3}
          aria-label={words.label}
          placeholder={words.placeholder}
          maxLength={GRAPHIC_LIMITS.textMax}
          value={composer.draft}
          disabled={frozen}
          onChange={(event) => composer.setDraft(event.target.value)}
          onKeyDown={(event) => {
            const action = composerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              // keyCode 229 is the key press that confirms an IME composition in browsers that
              // report the composition as over by the time keydown arrives.
              isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
            });
            if (action !== 'add') return;
            event.preventDefault();
            composer.submit();
          }}
          className="min-h-0 resize-none rounded-none border-0 bg-transparent px-3 py-2.5 leading-normal shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent [unicode-bidi:plaintext]"
        />
        {composer.notice !== null && (
          <p role="alert" className="m-0 px-3 pb-1 text-sm text-destructive">
            {composer.notice}
          </p>
        )}
        <div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            accept={ATTACH_ACCEPT}
            data-slot="attach-input"
            onChange={(event) => {
              composer.addFiles(Array.from(event.target.files ?? []));
              // The same file can be picked again after it was removed.
              event.target.value = '';
            }}
          />
          <Tip tip={COMPOSER_TEXT.attach} disabled={frozen} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={COMPOSER_TEXT.attach}
              disabled={frozen}
              onClick={() => picker.current?.click()}
              className="text-muted-foreground"
            >
              <Paperclip aria-hidden="true" />
            </Button>
          </Tip>
          <Tip tip={micLabel(snapshot)} disabled={frozen || micBusy} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={micLabel(snapshot)}
              aria-pressed={recording}
              disabled={frozen || micBusy}
              onClick={composer.voice.toggle}
              className={recording ? 'text-red-400' : 'text-muted-foreground'}
            >
              <Mic aria-hidden="true" />
            </Button>
          </Tip>
          <span className="flex-1" />
          <EffortMenu effort={composer.effort} onChange={composer.setEffort} disabled={frozen} />
          <Tip
            tip={composer.send.reason}
            disabled={!composer.send.enabled}
            side="top"
            align="end"
            wide
          >
            <Button
              type="button"
              size="sm"
              disabled={!composer.send.enabled}
              aria-busy={composer.sending}
              onClick={composer.submit}
              className="gap-2 has-[>svg]:px-3"
            >
              {composer.sending ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <ArrowUp aria-hidden="true" />
              )}
              {COMPOSER_TEXT.send}
            </Button>
          </Tip>
        </div>
      </div>
    </div>
  );
}

/** Effort ▾: Medium, High and Extra high (the default), the one in use checked. */
export function EffortMenu({
  effort,
  onChange,
  disabled,
}: {
  effort: Effort;
  onChange: (level: Effort) => void;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <Tip tip={COMPOSER_TEXT.effortTip} disabled={disabled} side="top">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="graphic-effort"
            aria-label={`${COMPOSER_TEXT.effortMenu}: ${EFFORT_LABELS[effort]}`}
            disabled={disabled}
            className="gap-1 text-[13px] text-muted-foreground"
          >
            {EFFORT_LABELS[effort]}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" side="top" className="w-44">
        <DropdownMenuLabel>{COMPOSER_TEXT.effortMenu}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={effort}
          onValueChange={(level) => {
            const choice = EFFORT_CHOICES.find((option) => option.level === level);
            if (choice) onChange(choice.level);
          }}
        >
          {EFFORT_CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice.level} value={choice.level}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
