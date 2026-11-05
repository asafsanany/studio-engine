// The list of a job's music (canvas page "Soundtrack", board SDMusic): the versions (v1, v2 …), No
// music and Make another with its words box, in all 8 states (made once or twice, making, failed,
// off, the folder's file, a style that says no music, a series episode). The Mac shows it in the
// Music button's popover, the phone in PhoneMusicSheet.
//
// With Songs on (canvas page "Songs", boards SGMusic and SGStates) the song Yael asked for is the
// first row, with the part of it the video uses; a song that could not be got says why above the
// list; and the box under it has two tabs: Another song (a link or a name, or Pick a trending one:
// each adds a Review note, and the editor re-cuts on Send) and Make music instead (the Make box).
// With Songs off none of it is there and the list is exactly as it was.

import type { MusicView } from '@studio/shared';
import { MUSIC_LIMITS } from '@studio/shared';
import { useMutationState } from '@tanstack/react-query';
import { Check, Loader2, Music, TrendingUp, Volume2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useJobs, useMakeMusic, usePickMusic, useSongsEnabled } from '@/data';
import { useSeriesText } from '@/features/series/SeriesMark';
import { cn } from '@/lib/utils';
import {
  MUSIC_TEXT,
  type MusicPartBar,
  type MusicRow,
  type MusicShape,
  musicListModel,
  retryAsk,
  SONG_TEXT,
  songNotedText,
} from './music-text';
import { useSongNotes } from './use-song-notes';

/** The most a link or a name typed in Another song can have (a note holds 2000 characters, and the words around it). */
const SONG_FIELD_MAX = 1000;

export type MusicBoxTab = 'song' | 'make';

export interface MusicListProps {
  jobId: string;
  /** The job's music (`useJobMusic(jobId).data`, never null here). */
  music: MusicView;
  /** Where it is shown: the Mac's popover or the phone's bottom sheet. */
  variant?: 'mac' | 'phone';
  /** The Mac's × in the header. The phone closes with its grabber, Back and Esc. */
  onClose?: () => void;
  /** Songs on: the tab the box under the list opens on. Default Another song. (For tests and the dev gallery.) */
  initialTab?: MusicBoxTab;
}

/**
 * The list. A series episode asks for the series' name (for its source line and the series' row);
 * every other job has everything it needs in its music.
 */
export function MusicList(props: MusicListProps) {
  return props.music.source === 'series' ? (
    <SeriesMusicList {...props} />
  ) : (
    <MusicListView {...props} series={null} />
  );
}

/** A job that is not in the list (it cannot be: Review is open on it) reads as in no series. */
const NO_SERIES_JOB = { id: '', clientId: '', seriesId: null, episode: null } as const;

function SeriesMusicList(props: MusicListProps) {
  const job = useJobs().data?.find((candidate) => candidate.id === props.jobId);
  const text = useSeriesText(job ?? NO_SERIES_JOB);
  const series =
    text === null ? null : { line: `${text.lead}${text.name ?? ''}`.trim(), name: text.name };
  return <MusicListView {...props} series={series} />;
}

type SeriesInfo = { line: string; name: string | null } | null;

/** The shape of each phone / Mac part: the phone's targets are 44 px, its text field is 16 px (iPhone Safari zooms into a smaller one). */
const LOOK = {
  mac: {
    header: 'border-b px-4 pt-3.5 pb-3',
    title: 'text-sm font-semibold',
    rows: 'p-1.5',
    row: 'rounded-[7px] px-2.5 py-2',
    radio: 'size-4',
    dot: 'size-2',
    make: 'px-4 pt-3 pb-3.5',
    field: 'h-8 rounded-[7px] px-2.5 text-[13px] md:text-[13px]',
    button: 'h-8 gap-1.5 px-3 text-[13px]',
  },
  phone: {
    header: 'px-4 pt-1 pb-2',
    title: 'text-base font-semibold',
    rows: 'px-1.5 pb-1.5',
    row: 'min-h-11 rounded-[10px] px-2.5 py-2.5',
    radio: 'size-5',
    dot: 'size-2.5',
    make: 'px-4 pt-3 pb-1',
    field: 'h-11 rounded-[10px] px-3 text-base md:text-base',
    button: 'h-11 gap-2 text-[15px]',
  },
} as const;

function MusicListView({
  jobId,
  music,
  variant = 'mac',
  onClose,
  initialTab = 'song',
  series,
}: MusicListProps & { series: SeriesInfo }) {
  const phone = variant === 'phone';
  const look = LOOK[variant];
  const askId = useId();
  const songId = useId();
  const now = useNow();
  const pick = usePickMusic(jobId);
  const make = useMakeMusic(jobId);
  const [ask, setAsk] = useState('');
  const [songText, setSongText] = useState('');
  const [tab, setTab] = useState<MusicBoxTab>(initialTab);

  // What this page sent to Make another, for Retry (the record forgets the words once a make fails).
  const sent = useMutationState({
    // The key of `useMakeMusic` (data/music-query.ts).
    filters: { mutationKey: ['music-make', jobId] },
    select: (mutation) => ({
      ask: mutation.state.variables as string | undefined,
      madeId: (mutation.state.data as MusicView | undefined)?.making?.id ?? null,
    }),
  });

  const songsOn = useSongsEnabled();
  const model = musicListModel(music, { now, series, songs: songsOn });
  const songNotes = useSongNotes(jobId, model.songBox !== null);
  const working = pick.isPending || make.isPending;
  /** Pick and Make another are refused by the engine now (`canMake`): they wait, and say why. */
  const locked = !music.canMake || working;
  const error = make.error?.message ?? pick.error?.message ?? null;
  // The phone's board has a shorter hint under Make another than the Mac's.
  const makeHint =
    phone && model.make?.hint === MUSIC_TEXT.hintAnother
      ? MUSIC_TEXT.hintAnotherPhone
      : (model.make?.hint ?? '');

  function choose(row: MusicRow) {
    if (row.checked || row.locked || locked) return;
    make.reset();
    pick.mutate(row.id);
  }

  function makeAnother(words: string | undefined) {
    if (locked || model.make?.busy) return;
    pick.reset();
    make.mutate(words === undefined || words.trim() === '' ? undefined : words.trim(), {
      onSuccess: () => setAsk(''),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    makeAnother(ask);
  }

  function submitSong(event: FormEvent) {
    event.preventDefault();
    songNotes.addSong(songText, () => setSongText(''));
  }

  // The Make box's field and button, its error and its hint: under the label before Songs, in the
  // Make music instead tab with them.
  const makeFields =
    model.make === null ? null : (
      <>
        <div className={cn('flex gap-2', phone && model.songBox === null && 'flex-col')}>
          <Input
            id={askId}
            type="text"
            dir="auto"
            value={ask}
            maxLength={MUSIC_LIMITS.askMax}
            disabled={locked || model.make.busy}
            aria-label={model.songBox?.makeField.label}
            placeholder={
              model.songBox !== null
                ? model.songBox.makeField.placeholder
                : phone
                  ? MUSIC_TEXT.askPlaceholderPhone
                  : MUSIC_TEXT.askPlaceholder
            }
            onChange={(event) => setAsk(event.target.value)}
            className={cn('min-w-0 flex-1 bg-background [unicode-bidi:plaintext]', look.field)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={locked || model.make.busy}
            aria-busy={model.make.busy || make.isPending}
            className={cn('flex-none', look.button)}
          >
            <Music aria-hidden="true" className={phone ? 'size-4' : 'size-3.5'} />
            {model.make.button}
          </Button>
        </div>
        {error !== null && (
          <span role="alert" className="text-[13px] text-red-300">
            {error}
          </span>
        )}
        <span className="text-xs text-zinc-500">
          {music.canMake || model.make.busy ? makeHint : (music.whyNot ?? makeHint)}
        </span>
      </>
    );

  return (
    // `data-own-keys`: the keys typed here are this list's, never the player's (Space, K, ← →).
    <div data-slot="music-list" data-own-keys="" data-variant={variant} className="flex flex-col">
      <div className={cn('flex items-start gap-2', look.header)}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={look.title}>{MUSIC_TEXT.title}</span>
          <span
            dir="auto"
            data-slot="music-source"
            className="text-left text-[13px] text-muted-foreground [unicode-bidi:plaintext]"
          >
            {model.source}
          </span>
        </div>
        {!phone && onClose !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={MUSIC_TEXT.close}
            onClick={onClose}
            className="-mt-1 -mr-1 size-7 text-muted-foreground"
          >
            <X className="size-[15px]" />
          </Button>
        )}
      </div>

      {model.alert !== null && (
        <div
          role="status"
          data-slot="music-alert"
          data-tone={model.alert.tone}
          className={cn(
            'mx-2.5 mt-2.5 mb-0.5 flex flex-col gap-1 rounded-lg border px-3 py-2.5',
            model.alert.tone === 'amber'
              ? 'border-amber-400/30 bg-amber-400/8'
              : 'border-white/10 bg-white/[0.03]',
          )}
        >
          <span
            className={cn(
              'text-[13px] font-medium',
              model.alert.tone === 'amber' ? 'text-amber-300' : 'text-foreground',
            )}
          >
            {model.alert.title}
          </span>
          {/* Two English sentences, left to right even when the record's words start with a Hebrew name (dir=auto would read the whole line right to left and scramble its punctuation); the name keeps its own direction inside. */}
          {[model.alert.text, model.alert.ask]
            .filter((line) => line !== '')
            .map((line) => (
              <span
                key={line}
                dir="ltr"
                className="text-left text-[13px] text-pretty text-zinc-200 [overflow-wrap:anywhere]"
              >
                {line}
              </span>
            ))}
        </div>
      )}

      <div
        role="radiogroup"
        aria-label={MUSIC_TEXT.pickLegend}
        className={cn('flex flex-col gap-0.5', look.rows)}
      >
        {model.making !== null && (
          <div
            role="status"
            data-slot="music-making"
            className={cn(
              'grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5 px-2.5 py-2',
              phone && 'grid-cols-[20px_minmax(0,1fr)_auto] gap-3',
            )}
          >
            <Loader2
              aria-hidden="true"
              className={cn('mt-0.5 animate-spin text-blue-500', phone ? 'size-5' : 'size-4')}
            />
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="font-medium">{model.making.title}</span>
              <span
                dir="auto"
                className="animate-pulse text-left text-[13px] text-muted-foreground [animation-timing-function:ease-in-out] [unicode-bidi:plaintext]"
              >
                {model.making.text}
              </span>
            </span>
            <span className="pt-px text-xs whitespace-nowrap text-zinc-500">
              {model.making.time}
            </span>
          </div>
        )}

        {model.rows.map((row) => (
          <MusicRowButton
            key={row.id}
            row={row}
            phone={phone}
            look={look}
            disabled={row.locked || (locked && !row.checked)}
            dim={locked && !row.locked && !row.checked}
            onChoose={choose}
          />
        ))}

        {model.failure !== null && (
          <div
            role="alert"
            data-slot="music-failure"
            className="mx-1 mt-1 mb-0.5 flex flex-col gap-2 rounded-lg border border-red-400/30 bg-red-400/8 py-2.5 pr-2 pl-3"
          >
            <span className="text-[13px] font-medium text-red-300">{model.failure.title}</span>
            <span className="text-[13px] text-pretty text-zinc-200">{model.failure.text}</span>
            <span className="flex gap-1.5">
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => makeAnother(retryAsk(music.failure?.id ?? null, sent))}
                className={cn('px-2.5 text-[13px]', phone ? 'h-11 px-4' : 'h-7')}
              >
                {MUSIC_TEXT.retry}
              </Button>
            </span>
          </div>
        )}
      </div>

      {model.note !== null && (
        <p
          dir="auto"
          className="px-4 pb-3 text-left text-[13px] text-pretty text-muted-foreground [unicode-bidi:plaintext]"
        >
          {model.note}
        </p>
      )}

      {songNotes.noted !== null && model.songBox !== null && (
        <div
          role="status"
          data-slot="music-noted"
          className="mx-2.5 mb-2.5 grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 rounded-lg bg-white/[0.04] px-3 py-2.5"
        >
          <Check aria-hidden="true" className="mt-px size-4 text-muted-foreground" />
          <span
            dir="auto"
            className="text-left text-[13px] text-pretty text-zinc-200 [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
          >
            {songNotedText(songNotes.noted, songNotes.client)}
          </span>
        </div>
      )}

      {model.make !== null && model.songBox === null && (
        <form
          data-slot="music-make"
          onSubmit={submit}
          className={cn('flex flex-col gap-2 border-t', look.make)}
        >
          <label htmlFor={askId} className="text-[13px] text-muted-foreground">
            {model.make.label}
          </label>
          {makeFields}
        </form>
      )}

      {model.make !== null && model.songBox !== null && (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value === 'make' ? 'make' : 'song')}
          data-slot="music-box"
          className={cn('gap-2 border-t', look.make)}
        >
          <TabsList
            variant="line"
            aria-label={SONG_TEXT.tabsLabel}
            className="-ml-2 h-8 w-full justify-start gap-1 p-0"
          >
            {(['song', 'make'] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className={cn(
                  'h-8 flex-none px-2 text-[13px] group-data-[orientation=horizontal]/tabs:after:bottom-0',
                  phone &&
                    "relative before:absolute before:-inset-y-[7px] before:inset-x-0 before:content-['']",
                )}
              >
                {model.songBox?.tabs[value]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="song">
            <form data-slot="music-song" onSubmit={submitSong} className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Input
                  id={songId}
                  type="text"
                  dir="auto"
                  value={songText}
                  maxLength={SONG_FIELD_MAX}
                  aria-label={model.songBox.song.label}
                  placeholder={model.songBox.song.placeholder}
                  disabled={songNotes.pending}
                  onChange={(event) => setSongText(event.target.value)}
                  className={cn(
                    'min-w-0 flex-1 bg-background [unicode-bidi:plaintext]',
                    look.field,
                  )}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={songNotes.pending}
                  aria-busy={songNotes.pending}
                  className={cn('flex-none', look.button)}
                >
                  {model.songBox.song.button}
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                data-slot="music-trend"
                disabled={songNotes.trendingAdded || songNotes.pending}
                onClick={() => songNotes.addTrending()}
                className={cn('self-start', look.button)}
              >
                <TrendingUp aria-hidden="true" className={phone ? 'size-4' : 'size-3.5'} />
                {songNotes.trendingAdded
                  ? model.songBox.song.trendAdded
                  : model.songBox.song.trendButton}
              </Button>
              {songNotes.error !== null && (
                <span role="alert" className="text-[13px] text-red-300">
                  {songNotes.error}
                </span>
              )}
              <span className="text-xs text-pretty text-zinc-500">{model.songBox.song.hint}</span>
            </form>
          </TabsContent>
          <TabsContent value="make">
            <form data-slot="music-make" onSubmit={submit} className="flex flex-col gap-2">
              {makeFields}
            </form>
          </TabsContent>
        </Tabs>
      )}

      {model.seriesBox !== null && (
        <div className="border-t px-4 py-3 text-[13px] text-pretty text-muted-foreground">
          {model.seriesBox}
          {error !== null && (
            <span role="alert" className="mt-2 block text-red-300">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface MusicRowButtonProps {
  row: MusicRow;
  phone: boolean;
  look: (typeof LOOK)[keyof typeof LOOK];
  disabled: boolean;
  /** Greyed: the engine won't take a pick now. */
  dim: boolean;
  onChoose: (row: MusicRow) => void;
}

/** One radio of the list: the dot, the title with its tag, the line under it, the shape and the time. */
function MusicRowButton({ row, phone, look, disabled, dim, onChoose }: MusicRowButtonProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native radio picks on the arrow keys, and a pick is a request to the engine that swaps the soundtrack; here Tab walks the rows and Enter or Space picks
    <button
      type="button"
      role="radio"
      aria-checked={row.checked}
      aria-disabled={disabled || undefined}
      data-row={row.id}
      data-checked={row.checked || undefined}
      onClick={() => onChoose(row)}
      className={cn(
        'group grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2.5 text-left transition-colors duration-150 ease-in-out outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/35 data-[checked]:bg-white/5 data-[checked]:hover:bg-accent',
        phone && 'grid-cols-[20px_minmax(0,1fr)_auto] gap-3 hover:bg-transparent active:bg-accent',
        disabled && 'cursor-default hover:bg-transparent data-[checked]:hover:bg-white/5',
        dim && 'opacity-60',
        look.row,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex shrink-0 items-center justify-center rounded-full border border-input shadow-xs transition-colors duration-150 ease-in-out dark:bg-input/30 group-data-[checked]:border-foreground',
          look.radio,
        )}
      >
        {row.checked && <span className={cn('rounded-full bg-foreground', look.dot)} />}
      </span>
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span
          className={cn(
            'flex min-w-0 items-baseline gap-2',
            row.kind === 'song' && 'flex-wrap gap-y-0.5',
          )}
        >
          <span
            dir="auto"
            className={cn(
              'min-w-0 flex-none truncate font-medium [unicode-bidi:plaintext]',
              row.kind === 'off' && 'text-zinc-200',
            )}
          >
            {row.title}
          </span>
          {row.artist !== '' && (
            <span
              dir="auto"
              data-slot="music-artist"
              className="flex-none text-muted-foreground [unicode-bidi:plaintext]"
            >
              {row.artist}
            </span>
          )}
          {row.playing && (
            <span className="inline-flex flex-none items-center gap-1 text-xs text-muted-foreground">
              <Volume2 aria-hidden="true" className="size-3" />
              {MUSIC_TEXT.inPreview}
            </span>
          )}
        </span>
        {row.describe !== '' && (
          <span
            dir="auto"
            className="text-left text-[13px] text-pretty text-muted-foreground [unicode-bidi:plaintext]"
          >
            {row.describe}
          </span>
        )}
        {row.shape !== null && <ShapeStrip shape={row.shape} />}
        {row.part !== null && <PartBar part={row.part} />}
      </span>
      <span className="pt-px text-xs whitespace-nowrap text-zinc-500 tabular-nums">{row.when}</span>
    </button>
  );
}

/** The song's part under the song when it is picked: the whole song as a bar, the part lit, its start and end in words. */
function PartBar({ part }: { part: MusicPartBar }): ReactNode {
  return (
    <span role="img" aria-label={part.label} className="mt-1 flex flex-col gap-1">
      <span
        aria-hidden="true"
        data-slot="music-part"
        className="relative block h-[18px] rounded-[3px] bg-zinc-700"
      >
        <span
          data-slot="music-part-used"
          style={{ left: `${part.startPct}%`, width: `${part.widthPct}%` }}
          className="absolute inset-y-0 rounded-[3px] bg-blue-500"
        />
      </span>
      <span
        aria-hidden="true"
        className="flex justify-between gap-2 text-xs text-zinc-500 tabular-nums"
      >
        <span>{part.from}</span>
        <span className="text-blue-300">{part.caption}</span>
        <span>{part.to}</span>
      </span>
    </span>
  );
}

/** The cut's shape under the version that is playing: a block per section, the drop lit, one line of words. */
function ShapeStrip({ shape }: { shape: MusicShape }): ReactNode {
  return (
    <span role="img" aria-label={shape.label} className="mt-1 flex flex-col gap-1">
      <span aria-hidden="true" data-slot="music-shape" className="flex h-[18px] gap-0.5">
        {shape.blocks.map((block) => (
          <span
            key={block.startMs}
            data-hot={block.hot || undefined}
            style={{ flex: `${block.ms} 1 0` }}
            className={cn('rounded-[3px] bg-zinc-700', block.hot && 'bg-blue-500')}
          />
        ))}
      </span>
      <span aria-hidden="true" className="text-xs text-zinc-500">
        {shape.parts.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts never change order; one plan, one caption
          <span key={index}>
            {index > 0 && ', '}
            {part.hot ? <span className="text-blue-300">{part.text}</span> : part.text}
          </span>
        ))}
      </span>
    </span>
  );
}
