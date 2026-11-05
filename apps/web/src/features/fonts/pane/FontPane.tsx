import { type FontFrame, familySlug, HEBREW_FALLBACK_FONT } from '@studio/shared';
import { useMemo, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { useFont, useFontsInNotesEnabled } from '@/data';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { useSelectedFamily } from '../use-selected-family';
import { FontPaneEmpty, FontPaneLoading, FontPaneView } from './FontPaneView';
import { DEFAULT_FONT_FRAME } from './font-frame-model';
import {
  chooseFace,
  DEFAULT_FONT_PANE_VIEW,
  type FaceChoices,
  FONT_PANE_TEXT,
  type FontPaneViewId,
  nearestFace,
  paneFonts,
  rememberFace,
  sortFaces,
} from './font-pane-model';
import { useFontFaces } from './use-font-face';

/**
 * The 440 px side pane (boards FOPage and FOStates) for the open family, which it reads through
 * `useSelectedFamily()` (../use-selected-family.ts) and `GET /api/fonts/:slug`: the name and "Sans ·
 * Hebrew + English · 9 weights", the Text | On a frame switch, the view the switch is on, the facts
 * (Script, Style, Weights, Files, Used in, Added) and, once notes can name a font, "To use it,
 * write @Heebo Bold in a note on a job.".
 *
 * Text (FN7, FontTextView.tsx): the specimen, a box to try your own text, the no-Hebrew note and
 * one row per weight. On a frame (FN8, FontFrameView.tsx): the caption on a photo, with the chips
 * Person · Street · Interior.
 *
 * The view, the test frame, the typed text and the weight chosen for each family belong to the
 * pane, not to one family: moving to the next row keeps the view, the frame and the typed text, and
 * coming back to a family finds the weight it was left on. All of it is forgotten on a reload.
 */
export function FontPane() {
  const { selected } = useSelectedFamily();
  const [view, setView] = useState<FontPaneViewId>(DEFAULT_FONT_PANE_VIEW);
  const [frame, setFrame] = useState<FontFrame>(DEFAULT_FONT_FRAME);
  const [tryText, setTryText] = useState('');
  const [choices, setChoices] = useState<FaceChoices>({});

  if (selected === null) return <FontPaneEmpty />;
  return (
    <OpenFontPane
      slug={selected}
      view={view}
      onView={setView}
      frame={frame}
      onFrame={setFrame}
      tryText={tryText}
      onTryText={setTryText}
      choices={choices}
      onChoices={setChoices}
    />
  );
}

export interface OpenFontPaneProps {
  slug: string;
  view: FontPaneViewId;
  onView: (view: FontPaneViewId) => void;
  frame: FontFrame;
  onFrame: (frame: FontFrame) => void;
  tryText: string;
  onTryText: (text: string) => void;
  choices: FaceChoices;
  onChoices: (choices: FaceChoices) => void;
}

/** The pane for the open family `slug`; exported so a test can hand in the pane's state. */
export function OpenFontPane({ slug, ...rest }: OpenFontPaneProps) {
  const font = useFont(slug);
  const detail = font.data;
  const showLoading = useDelayedFlag(detail === undefined && font.isPending, SKELETON_DELAY_MS);

  if (detail === undefined) {
    if (font.isError) return <FontPaneEmpty text={FONT_PANE_TEXT.gone} />;
    return <FontPaneLoading show={showLoading} />;
  }
  return <LoadedFontPane detail={detail} {...rest} />;
}

type LoadedFontPaneProps = Omit<OpenFontPaneProps, 'slug'> & {
  detail: NonNullable<ReturnType<typeof useFont>['data']>;
};

/** One font on the page: puts its files in the page and sets the specimen in them. */
function LoadedFontPane({
  detail,
  view,
  onView,
  frame,
  onFrame,
  tryText,
  onTryText,
  choices,
  onChoices,
}: LoadedFontPaneProps) {
  const inNotes = useFontsInNotesEnabled();
  const now = useNow();
  const faces = useMemo(() => sortFaces(detail.faces), [detail.faces]);
  const face = chooseFace(faces, choices[detail.slug]) ?? faces[0];

  // Every weight row is set in its own weight, so every file of the family comes into the page.
  const loads = useFontFaces(faces);

  // A font with no Hebrew keeps Heebo for its Hebrew: Heebo from the library when it has it (the
  // same file the edit uses), else a Heebo or Hebrew font the Mac already has.
  const heebo = useFont(detail.he ? undefined : familySlug(HEBREW_FALLBACK_FONT));
  const heeboFaces = heebo.data?.faces;
  const heeboFace = useMemo(
    () => (heeboFaces && face ? nearestFace(heeboFaces, face.weight) : null),
    [heeboFaces, face],
  );
  const heeboChosen = useMemo(() => (heeboFace ? [heeboFace] : []), [heeboFace]);
  useFontFaces(heeboChosen, heeboFaces);

  if (!face) return <FontPaneEmpty text={FONT_PANE_TEXT.gone} />;
  const index = faces.indexOf(face);

  return (
    <FontPaneView
      detail={detail}
      face={face}
      fonts={paneFonts(detail, face, heeboFace)}
      view={view}
      onView={onView}
      frame={frame}
      onFrame={onFrame}
      tryText={tryText}
      onTryText={onTryText}
      onFace={(next) => onChoices(rememberFace(choices, detail.slug, next))}
      failed={loads[index] === 'failed'}
      now={now}
      inNotes={inNotes}
    />
  );
}
