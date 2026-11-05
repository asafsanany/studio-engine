import type { FontFaceInfo, FontFamilyDetail, FontFrame } from '@studio/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FontFrameView } from './FontFrameView';
import { FontTextView } from './FontTextView';
import {
  FONT_PANE_TEXT,
  FONT_PANE_VIEWS,
  type FontPaneViewId,
  faceTag,
  isFontPaneView,
  type PaneFact,
  type PaneFonts,
  paneFacts,
  paneSubtitle,
} from './font-pane-model';

/** The words on a bare pane: nothing is open, or the open font could not be read. */
export function FontPaneEmpty({ text = FONT_PANE_TEXT.empty }: { text?: string }) {
  return (
    <section
      data-slot="font-pane"
      aria-label={FONT_PANE_TEXT.label}
      className="flex flex-1 items-center justify-center text-center text-muted-foreground"
    >
      <h2 className="sr-only">{FONT_PANE_TEXT.label}</h2>
      {text}
    </section>
  );
}

/** The pane while the font's facts are on their way: a skeleton, once the wait has gone on a while. */
export function FontPaneLoading({ show }: { show: boolean }) {
  return (
    <section
      data-slot="font-pane"
      aria-label={FONT_PANE_TEXT.label}
      aria-busy="true"
      className="flex flex-col gap-3.5"
    >
      {show && (
        <>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-8 w-44 rounded-lg" />
          <Skeleton className="h-52 rounded-xl" />
        </>
      )}
    </section>
  );
}

/** The plain label / value list: 80 px labels, values that cut off with an ellipsis. */
export function FontFacts({ facts }: { facts: readonly PaneFact[] }) {
  return (
    <dl
      data-slot="font-facts"
      className="m-0 grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]"
    >
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="m-0 min-w-0 truncate" title={fact.value}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "To use it, write @Heebo Bold in a note on a job." with the tag in a small mono chip. */
export function FontUseLine({ tag }: { tag: string }) {
  return (
    <p data-slot="font-use" className="m-0 text-[13px] text-muted-foreground">
      {FONT_PANE_TEXT.useLead}{' '}
      <span className="inline-block rounded-md border bg-card px-1.5 font-mono text-xs leading-[1.43] text-foreground">
        {tag}
      </span>{' '}
      {FONT_PANE_TEXT.useTail}
    </p>
  );
}

export interface FontPaneViewProps {
  detail: FontFamilyDetail;
  /** The chosen face. */
  face: FontFaceInfo;
  fonts: PaneFonts;
  view: FontPaneViewId;
  onView: (view: FontPaneViewId) => void;
  /** The test frame the On a frame view is on, and a chip choosing another. */
  frame: FontFrame;
  onFrame: (frame: FontFrame) => void;
  tryText: string;
  onTryText: (text: string) => void;
  onFace: (face: FontFaceInfo) => void;
  /** The chosen face's file could not be had. */
  failed: boolean;
  /** Epoch ms, for "Added 2 days ago". */
  now: number;
  /** Notes can name a font (the fontsInNotes switch is on): the last line shows. */
  inNotes: boolean;
}

/**
 * The whole pane for one font: the name and its line, the Text | On a frame switch, the view the
 * switch is on, the facts and, once notes can name a font, how to name this weight. FN7's Text view
 * is `FontTextView`; the On a frame view is `FontFrameView` (FN8).
 */
export function FontPaneView(props: FontPaneViewProps) {
  const { detail, face, fonts, view, onView, now, inNotes } = props;

  return (
    <section
      data-slot="font-pane"
      aria-label={FONT_PANE_TEXT.label}
      className="flex flex-col gap-3.5"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-lg leading-[1.35] font-semibold tracking-[-0.01em]">
          {detail.name}
        </h2>
        <span className="text-[13px] text-muted-foreground">{paneSubtitle(detail)}</span>
      </div>
      <Tabs
        value={view}
        onValueChange={(value) => {
          if (isFontPaneView(value)) onView(value);
        }}
      >
        <TabsList
          aria-label={FONT_PANE_TEXT.show}
          className="gap-0.5 self-start group-data-[orientation=horizontal]/tabs:h-[34px]"
        >
          {FONT_PANE_VIEWS.map(({ id, label }) => (
            <TabsTrigger key={id} value={id} className="h-7 px-[11px] text-[13px]">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {view === 'text' ? (
        <FontTextView
          detail={detail}
          face={face}
          fonts={fonts}
          tryText={props.tryText}
          onTryText={props.onTryText}
          onFace={props.onFace}
          failed={props.failed}
        />
      ) : (
        <FontFrameView
          detail={detail}
          face={face}
          fonts={fonts}
          frame={props.frame}
          onFrame={props.onFrame}
          failed={props.failed}
        />
      )}
      <FontFacts facts={paneFacts(detail, now)} />
      {inNotes && <FontUseLine tag={faceTag(detail, face)} />}
    </section>
  );
}
