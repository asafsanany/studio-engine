// One graphic and its chat (Graphics plan, "Studio"; board GRStudio): three columns under the
// app's header. Left, the chat (the thread and the composer, 400 px); in the middle, the preview
// (GraphicPreview, GR3); on the right, About (300 px). Below about 1250 px of window the two side
// columns narrow (studio-columns.ts) so the preview keeps its room. Above them, the page's own
// bar: ‹ Graphics, the name to rename, its status, Show in Finder and ⋯. `/graphics/new` is the
// empty studio: the first Send creates the graphic, then replaces the address with /graphics/<id>.
// The graphic and its chat are live through the graphic events (data/graphics-cache.ts).

import type { GraphicDetail } from '@studio/shared';
import { useMemo, useRef, useState } from 'react';
import { ApiError, useEngineReconnecting, useGraphic } from '@/data';
import { cn } from '@/lib/utils';
import { DeleteGraphicDialog } from '../list/DeleteGraphicDialog';
import { AboutPanel } from './AboutPanel';
import { ChatThread } from './ChatThread';
import { GraphicPreview } from './GraphicPreview';
import type { GraphicPreviewProps } from './preview-props';
import { StudioComposer } from './StudioComposer';
import { StudioHeader } from './StudioHeader';
import { StudioFrame, StudioGone, StudioLoading, StudioUnreachable } from './StudioStates';
import type { StudioActions } from './studio-actions';
import { CHAT_COLUMN_WIDTH } from './studio-columns';
import {
  chatRows,
  chatSignature,
  pinAfterPick,
  resolveValues,
  shownVersion,
  type TypedValues,
  type VersionPin,
} from './studio-logic';
import { CHAT_TEXT } from './studio-text';
import { useStudioActions } from './use-studio-actions';
import { useStudioComposer } from './use-studio-composer';

/** The studio of graphic `id`, or the empty one for a new graphic (`id` undefined). */
export function GraphicStudio({ id }: { id: string | undefined }) {
  return id === undefined ? <NewStudio /> : <KnownGraphic id={id} />;
}

function KnownGraphic({ id }: { id: string }) {
  const query = useGraphic(id);
  if (query.data !== undefined) return <ExistingStudio graphic={query.data} />;
  if (query.error instanceof ApiError && query.error.status === 404) {
    return <StudioGone graphicId={id} />;
  }
  if (query.isError) {
    return <StudioUnreachable graphicId={id} onRetry={() => void query.refetch()} />;
  }
  return <StudioLoading graphicId={id} />;
}

function NewStudio() {
  return <StudioLayout graphic={undefined} actions={null} deleting={false} />;
}

function ExistingStudio({ graphic }: { graphic: GraphicDetail }) {
  const { deleting, ...actions } = useStudioActions(graphic.id);
  return <StudioLayout graphic={graphic} actions={actions} deleting={deleting} />;
}

export interface StudioLayoutProps {
  /** `undefined` on /graphics/new. */
  graphic: GraphicDetail | undefined;
  /** The buttons of the graphic; `null` while there is no graphic yet. */
  actions: StudioActions | null;
  deleting: boolean;
  /** Opens with an older version already picked in the chat (tests). */
  initialPin?: VersionPin | null;
}

/** The three columns and the bar above them, over a graphic (or the empty studio) and its buttons. */
export function StudioLayout({ graphic, actions, deleting, initialPin = null }: StudioLayoutProps) {
  const offline = useEngineReconnecting();
  const composer = useStudioComposer({ graphic, offline });

  /** An older version picked in the chat (the player follows the newest again when a new one arrives). */
  const [pin, setPin] = useState<VersionPin | null>(initialPin);
  /** What the owner typed in "Text in it": it is only tried in the preview, never saved. */
  const [typed, setTyped] = useState<TypedValues>({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** The chat row whose Stop or Retry is on its way. */
  const [pendingId, setPendingId] = useState<string | null>(null);

  const newest = graphic?.version ?? null;
  const shown = shownVersion(pin, newest);
  const making = graphic?.status === 'making';
  const messages = graphic?.messages;
  const rows = useMemo(() => chatRows(messages ?? []), [messages]);
  const variables = graphic?.variables;
  const values = useMemo(() => resolveValues(variables ?? [], typed), [variables, typed]);

  async function whilePending(messageId: string, run: () => Promise<boolean>) {
    setPendingId(messageId);
    try {
      await run();
    } finally {
      setPendingId(null);
    }
  }

  const previewProps: GraphicPreviewProps = {
    graphic,
    shownVersion: shown,
    newestVersion: newest,
    values,
    making: graphic?.makingVersion ?? null,
    onBackToNewest: () => setPin(null),
    onUseOld: () => {
      // Only an older version can be used again; the newest is what edits use already.
      if (actions === null || shown === null || shown === newest) return;
      void actions.restore(shown).then((restored) => {
        if (restored) setPin(null);
      });
    },
  };

  return (
    <StudioFrame graphicId={graphic?.id}>
      <StudioHeader
        graphic={graphic}
        offline={offline}
        onRename={(name) => actions?.rename(name) ?? Promise.resolve(false)}
        onToggleUses={() => void actions?.setUses(graphic?.uses === false)}
        onReveal={() => void actions?.reveal()}
        onDuplicate={() => void actions?.duplicate()}
        onDelete={() => setDeleteOpen(true)}
      />
      <div className="@container flex min-h-0 flex-1">
        <section
          aria-label={CHAT_TEXT.label}
          className={cn('flex min-h-0 flex-none flex-col border-r', CHAT_COLUMN_WIDTH)}
        >
          <ChatThread
            rows={rows}
            signature={chatSignature(messages ?? [])}
            shown={shown}
            making={making}
            offline={offline}
            pendingId={pendingId}
            onShow={(version) => setPin(pinAfterPick(version, newest))}
            onStop={(messageId) =>
              void whilePending(messageId, () => actions?.stop(messageId) ?? Promise.resolve(false))
            }
            onRetry={(messageId) =>
              void whilePending(
                messageId,
                () => actions?.retry(messageId) ?? Promise.resolve(false),
              )
            }
            onStarter={(request) => {
              composer.setDraft(request);
              textarea.current?.focus();
            }}
          />
          <StudioComposer
            composer={composer}
            hasMessages={rows.length > 0}
            offline={offline}
            textareaRef={textarea}
          />
        </section>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white/[0.015]">
          <GraphicPreview {...previewProps} />
        </div>
        <AboutPanel
          graphic={graphic}
          typed={typed}
          onType={(fieldId, text) => setTyped((current) => ({ ...current, [fieldId]: text }))}
          onSaveWhen={(text) =>
            actions?.saveWhen(text, graphic?.when ?? '') ?? Promise.resolve(false)
          }
          onSetUses={(uses) => void actions?.setUses(uses)}
          offline={offline}
        />
      </div>
      {graphic !== undefined && (
        <DeleteGraphicDialog
          open={deleteOpen}
          name={graphic.name}
          pending={deleting}
          onOpenChange={setDeleteOpen}
          onConfirm={() => {
            void actions?.remove(graphic.name).then((deleted) => {
              if (!deleted) setDeleteOpen(false);
            });
          }}
        />
      )}
    </StudioFrame>
  );
}
