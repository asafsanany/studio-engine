// Dev-only gallery of the shadcn primitives (CVP-68), reachable at /components when running
// `pnpm dev`. It mirrors the "Components" board of the design canvas, section by section, so the
// two can be compared side by side. Loaded lazily from main.tsx behind `import.meta.env.DEV`, so
// it never ships in a production build. There is no router yet, so this is an ad-hoc route.

import type { InputCounts as InputCountsData } from '@studio/shared';
import { Check, ChevronDown, Copy, Download, RotateCcw, Search, Send, Users } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Clapperboard, ListVideo, Pause, Play, Square } from '@/components/icons';
import { IconAction } from '@/components/jobs/IconAction';
import { InputCounts } from '@/components/jobs/InputCounts';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import { StatusBadge, type StatusBadgeJob } from '@/components/jobs/StatusBadge';
import { StepProgress, type StepProgressJob } from '@/components/jobs/StepProgress';
import { useNow } from '@/components/jobs/use-now';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ICON_LABELS, type IconKind, StatusGlyph } from '@/features/jobs/JobStatusIcon';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { GraphicPreviewGallery } from './GraphicPreviewGallery';
import { PreviewPlayerGallery } from './PreviewPlayerGallery';
import { ReviewDialogGallery } from './ReviewDialogGallery';

function Section({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-3.5 rounded-[10px] border p-6', className)}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="font-mono text-xs text-muted-foreground">{note}</div>
      </div>
      {children}
    </section>
  );
}

// Row actions: Button size icon-sm (32) with a Tooltip carrying the label.
const ACTIONS = [
  { label: 'Hold', icon: Pause },
  { label: 'Release', icon: Play },
  { label: 'Cancel', icon: Square },
  { label: 'Retry from step', icon: RotateCcw },
  { label: 'Copy error', icon: Copy },
  { label: 'Copied', icon: Check, done: true },
  { label: 'Resume', icon: Play },
  { label: 'Download MP4', icon: Download, primary: true },
] as const;

function RowActions() {
  return (
    <Section title="Row actions" note="Button · size icon-sm (32) · outline / default · Tooltip">
      <div className="flex flex-wrap gap-5">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <div key={action.label} className="flex w-[72px] flex-col items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant={'primary' in action ? 'default' : 'outline'}
                    aria-label={action.label}
                  >
                    <Icon className={'done' in action ? 'text-status-ready' : undefined} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{action.label}</TooltipContent>
              </Tooltip>
              <span className="text-center text-xs text-muted-foreground">{action.label}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 border-t pt-1.5">
        <Button variant="outline">
          Columns
          <ChevronDown />
        </Button>
        <Button variant="outline">Keep editing</Button>
        <Button variant="destructive">Stop edit</Button>
      </div>
    </Section>
  );
}

const TABS = [
  { value: 'all', label: 'All', count: 12 },
  { value: 'progress', label: 'In progress', count: 4 },
  { value: 'approved', label: 'Approved', count: 2 },
  { value: 'delivered', label: 'Delivered', count: 2 },
  { value: 'uploaded', label: 'Uploaded', count: 1 },
  { value: 'paid', label: 'Paid', count: 1 },
  { value: 'attention', label: 'Needs attention', count: 3 },
] as const;

function SearchInput({
  forcedFocus,
  ...props
}: React.ComponentProps<'input'> & { forcedFocus?: boolean }) {
  return (
    <div className="relative w-64">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
      />
      {/* dir="auto" only: as on the board, Hebrew text sits at the right of the field. */}
      <Input
        dir="auto"
        className={cn('pl-[34px]', forcedFocus && 'border-ring ring-[3px] ring-ring/35')}
        {...props}
      />
    </div>
  );
}

function Toolbar() {
  return (
    <Section title="Toolbar" note="Tabs (TabsList + TabsTrigger + count) · Input with icon">
      <Tabs defaultValue="all">
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} count={tab.count}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap gap-3">
        <SearchInput placeholder="Search" aria-label="Search jobs" />
        <SearchInput defaultValue="מאפ" aria-label="Search jobs (Hebrew, focused)" forcedFocus />
      </div>
    </Section>
  );
}

const STATES = [
  { dot: 'bg-status-neutral', label: 'Arriving', detail: 'settles in 0:42' },
  { dot: 'bg-status-neutral', label: 'Queued', detail: '#2 in line' },
  { dot: 'bg-status-held', label: 'Held', detail: '' },
  { dot: 'bg-status-ready', label: 'Approved', detail: '0:45 · 1080×1920 · 62 MB' },
  { dot: 'bg-status-failed', label: 'Failed at Render', detail: '', failed: true },
  { dot: 'bg-status-cancelled', label: 'Cancelled', detail: 'at Plan' },
] as const;

function Status() {
  return (
    <Section
      title="Status"
      note="Badge · variant outline + dot · Failed uses destructive tint + Tooltip"
    >
      {STATES.map((state) => {
        const badge = (
          <Badge variant={'failed' in state ? 'destructive' : 'outline'}>
            <BadgeDot className={state.dot} />
            {state.label}
          </Badge>
        );
        return (
          <div key={state.label} className="flex h-7 items-center gap-2">
            {'failed' in state ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="rounded-sm">
                    {badge}
                  </button>
                </TooltipTrigger>
                <TooltipContent wide>
                  Render stopped: not enough disk space. Needs about 4 GB free on Macintosh HD.
                </TooltipContent>
              </Tooltip>
            ) : (
              badge
            )}
            <span className="text-muted-foreground tabular-nums">{state.detail}</span>
          </div>
        );
      })}
    </Section>
  );
}

const JOBS = [
  { initials: 'מה', name: 'פרומו לסוף השבוע', client: 'מאפיית הצפון' },
  { initials: 'AF', name: 'Class schedule', client: 'Arc Fitness' },
  { initials: 'טנ', name: 'Open house tour', client: 'טל נכסים' },
] as const;

function JobCell() {
  return (
    <Section
      title="Job cell"
      note="Avatar (initials) · dir=auto names (StepProgress and InputCounts are custom components, not part of F2)"
    >
      {JOBS.map((job) => (
        <div key={job.name} className="flex h-12 items-center gap-3">
          <Avatar>
            <AvatarFallback dir="auto">{job.initials}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col">
            <Bidi className="font-medium">{job.name}</Bidi>
            <Bidi className="text-xs text-muted-foreground">{job.client}</Bidi>
          </span>
        </div>
      ))}
    </Section>
  );
}

const TOOLTIPS = [
  { text: 'Hold' },
  { text: 'Tue 20 Oct 2026, 13:41' },
  { text: '14 video clips' },
  {
    text: 'Render stopped: not enough disk space. Needs about 4 GB free on Macintosh HD.',
    wide: true,
  },
] as const;

function TooltipDemo() {
  // Pinned open so each tooltip can be compared with the board. The tooltips in Row actions and
  // Status are the unpinned ones: hover them to see the real 300 ms delay.
  return (
    <Section
      title="Tooltip"
      note="Tooltip · restyled to popover surface (bg-popover, border) instead of shadcn's inverted default"
    >
      <div className="grid grid-cols-3 gap-x-4 gap-y-2">
        {TOOLTIPS.map((tip) => (
          <div key={tip.text} className={'wide' in tip ? 'col-span-3 pb-16' : 'pb-8'}>
            <Tooltip open>
              <TooltipTrigger asChild>
                <span className="block h-0 w-px" />
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" sideOffset={0} wide={'wide' in tip}>
                {tip.text}
              </TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </Section>
  );
}

const COLUMNS = ['Job', 'Client', 'Inputs', 'Size', 'Added', 'Last updated', 'Status', 'Action'];
const LOCKED = new Set(['Job', 'Status', 'Action']);

function ColumnsMenu() {
  const [open, setOpen] = useState(true);
  const [shown, setShown] = useState(() => new Set(COLUMNS.filter((c) => c !== 'Size')));
  return (
    <Section
      title="Columns menu"
      note="DropdownMenu · DropdownMenuCheckboxItem · locked columns disabled at 50%"
    >
      <div className="min-h-80">
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              Columns
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-44"
            // Pinned open for the gallery: only the trigger (or Escape) closes it.
            onInteractOutside={(event) => event.preventDefault()}
          >
            {COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={shown.has(column)}
                disabled={LOCKED.has(column)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  setShown((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(column);
                    else next.delete(column);
                    return next;
                  })
                }
              >
                {column}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Section>
  );
}

function CancelConfirmation() {
  return (
    <Section
      title="Cancel confirmation"
      note="AlertDialog · AlertDialogCancel (outline) · AlertDialogAction (destructive) · click to open"
    >
      <div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Stop edit</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop this edit?</AlertDialogTitle>
              <AlertDialogDescription>
                Finished steps are kept, so you can resume later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction variant="destructive">Stop edit</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  );
}

function PaginationAndEmpty() {
  return (
    <Section
      title="Pagination · empty rows"
      note="Pagination (Previous / PaginationLink isActive / Next) · TableRow empty state"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground">1–10 of 12</span>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" disabled />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>
                1
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">2</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell className="h-24 text-center text-muted-foreground">
                No matching jobs.
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {JOBS.map((job, index) => (
              <TableRow key={job.name}>
                <TableCell>
                  <Bidi className="font-medium">{job.name}</Bidi>
                </TableCell>
                <TableCell>
                  <Bidi className="text-muted-foreground">{job.client}</Bidi>
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {index * 21 + 18} MB
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

const NAV = [
  { label: 'Jobs', icon: ListVideo, active: true },
  { label: 'Clients', icon: Users, disabled: true },
  { label: 'Deliveries', icon: Send, disabled: true },
] as const;

function SidebarDemo({ defaultOpen, label }: { defaultOpen: boolean; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-xs text-muted-foreground">{label}</div>
      {/* The transform makes this box the containing block of the sidebar's fixed positioning. */}
      <div className="relative h-72 overflow-hidden rounded-[10px] border [transform:translateZ(0)]">
        <SidebarProvider defaultOpen={defaultOpen} className="h-full min-h-0">
          <Sidebar collapsible="icon" className="absolute h-full">
            <SidebarHeader className="h-14 flex-row items-center gap-2.5 border-b px-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Clapperboard className="size-4" />
              </span>
              <span className="text-sm font-semibold whitespace-nowrap group-data-[collapsible=icon]:hidden">
                Studio Engine
              </span>
            </SidebarHeader>
            <SidebarContent className="p-2">
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton
                      isActive={'active' in item}
                      aria-disabled={'disabled' in item || undefined}
                      tooltip={item.label}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarContent>
            <SidebarFooter className="border-t p-2">
              <SidebarTrigger />
            </SidebarFooter>
          </Sidebar>
          <SidebarInset className="p-4 text-muted-foreground">Page content</SidebarInset>
        </SidebarProvider>
      </div>
    </div>
  );
}

function SidebarSection() {
  return (
    <Section
      className="lg:col-span-2"
      title="Sidebar"
      note="Sidebar · 14rem expanded, 3rem icon mode · card surface, accent and white/10% border tokens"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <SidebarDemo defaultOpen label="expanded (14rem = 224px)" />
        <SidebarDemo defaultOpen={false} label="icon mode (3rem = 48px)" />
      </div>
    </Section>
  );
}

// ---- F3 · Job components (CVP-69) --------------------------------------------------------------
// The five app-specific pieces in every state of the Components board. Times are pinned to the
// board's clock (Tue 20 Oct 2026, 13:42, viewer's zone) so the text matches it; the "live" rows
// at the end use the real clock.

const NOW = new Date(2026, 9, 20, 13, 42).getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const NO_STATUS: StatusBadgeJob = {
  state: 'queued',
  placeInLine: null,
  settlesAt: null,
  output: null,
  failedAt: null,
  stoppedAt: null,
  error: null,
  preview: null,
  round: 0,
};

const STATUS_JOBS: readonly StatusBadgeJob[] = [
  { ...NO_STATUS, state: 'arriving', settlesAt: new Date(NOW + 42_000).toISOString() },
  { ...NO_STATUS, state: 'queued', placeInLine: 2 },
  { ...NO_STATUS, state: 'held' },
  {
    ...NO_STATUS,
    state: 'ready',
    output: {
      fileName: 'Kova Coffee/Menu launch.mp4',
      durationSec: 45,
      width: 1080,
      height: 1920,
      sizeBytes: 62_000_000,
    },
  },
  {
    ...NO_STATUS,
    state: 'failed',
    failedAt: 8,
    error: 'Render stopped: not enough disk space. Needs about 4 GB free on Macintosh HD.',
  },
  { ...NO_STATUS, state: 'cancelled', stoppedAt: 4 },
  { ...NO_STATUS, state: 'review', preview: { durationSec: 28.4, width: 1080, height: 1920 } },
  {
    ...NO_STATUS,
    state: 'review',
    round: 2,
    preview: { durationSec: 28.4, width: 1080, height: 1920 },
  },
  // Not on the board (the table shows StepProgress for editing), but StatusBadge handles it.
  { ...NO_STATUS, state: 'editing' },
];

function CountdownBadge() {
  // The pattern for a live countdown: the owner of the clock passes `now` down once a second.
  const now = useNow(1000);
  const [settlesAt] = useState(() => new Date(Date.now() + 42_000).toISOString());
  return <StatusBadge job={{ ...NO_STATUS, state: 'arriving', settlesAt }} now={now} />;
}

function JobStatusSection() {
  return (
    <Section
      title="Status badge"
      note="StatusBadge · FailedBadge (tooltip with the error) · detail text from statusDetail()"
    >
      {STATUS_JOBS.map((job) => (
        <div key={`${job.state}-${job.round}`} className="flex h-7 items-center">
          <StatusBadge job={job} now={NOW} />
        </div>
      ))}
      <div className="flex h-7 items-center gap-3 border-t pt-1.5">
        <CountdownBadge />
        <span className="font-mono text-xs text-muted-foreground">live countdown, 1 s tick</span>
      </div>
    </Section>
  );
}

// The icon of every state and stage on the Jobs page. A ready job draws its stage: Approved (the
// green check), Delivered (an arrow right), Uploaded (an arrow up, violet: a reel is linked to it)
// and Paid (the shekel sign).
const ICON_KINDS = Object.keys(ICON_LABELS) as IconKind[];

function StatusIconsSection() {
  return (
    <Section
      title="Status icons"
      note="JobStatusIcon · 16 px · the stages of a finished job in order: Approved, Delivered, Uploaded, Paid"
    >
      <div className="flex flex-wrap gap-5">
        {ICON_KINDS.map((kind) => (
          <div key={kind} className="flex w-[72px] flex-col items-center gap-2">
            <StatusGlyph kind={kind} step={5} role="img" aria-label={ICON_LABELS[kind]} />
            <span className="text-center text-xs text-muted-foreground">{ICON_LABELS[kind]}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

const PROGRESS_JOBS: readonly StepProgressJob[] = [
  { step: 2, subProgress: '6/14', etaSec: 540, runKind: 'edit', round: 0 },
  { step: 5, subProgress: 'graphics 2/5', etaSec: 240, runKind: 'edit', round: 0 },
  { step: 7, subProgress: 'pass 2/3', etaSec: 120, runKind: 'edit', round: 0 },
  { step: 8, subProgress: null, etaSec: null, runKind: 'edit', round: 0 },
  { step: 5, subProgress: 'graphics 2/5', etaSec: 240, runKind: 'revise', round: 2 },
  { step: 8, subProgress: null, etaSec: 180, runKind: 'render', round: 1 },
];

function StepProgressSection() {
  return (
    <Section
      title="Step progress"
      note="StepProgress · 8 segments · Brief Transcribe Scan Plan Cut Preview Check Render · revise: round N · render: approved"
    >
      {PROGRESS_JOBS.map((job) => (
        <StepProgress key={`${job.runKind}-${job.step}`} job={job} className="w-80" />
      ))}
    </Section>
  );
}

const INPUT_JOBS: readonly {
  initials: string;
  name: string;
  client: string;
  inputs: InputCountsData;
}[] = [
  {
    initials: 'מה',
    name: 'פרומו לסוף השבוע',
    client: 'מאפיית הצפון',
    inputs: { video: 14, audio: 3, image: 1, doc: 1 },
  },
  {
    initials: 'AF',
    name: 'Class schedule',
    client: 'Arc Fitness',
    inputs: { video: 0, audio: 1, image: 5, doc: 0 },
  },
  {
    initials: 'טנ',
    name: 'Open house tour',
    client: 'טל נכסים',
    inputs: { video: 22, audio: 0, image: 0, doc: 1 },
  },
];

function InputsSection() {
  return (
    <Section
      title="Job cell · Inputs"
      note="Avatar (initials) · dir=auto names · InputCounts (video, audio, image, doc; 0 at 50%)"
    >
      {INPUT_JOBS.map((job) => (
        <div
          key={job.name}
          className="grid h-12 grid-cols-[minmax(0,1fr)_172px] items-center gap-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            <Avatar>
              <AvatarFallback dir="auto">{job.initials}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col">
              <Bidi className="font-medium">{job.name}</Bidi>
              <Bidi className="text-xs text-muted-foreground">{job.client}</Bidi>
            </span>
          </div>
          <InputCounts inputs={job.inputs} />
        </div>
      ))}
    </Section>
  );
}

function JobActionsSection() {
  // The right column holds only the step that moves a job forward; the rest is in the row's menu.
  const actions = [
    { label: 'Start now', node: <IconAction action="start" label="Start now" /> },
    { label: 'Release', node: <IconAction action="release" label="Release" /> },
    { label: 'Retry from step', node: <IconAction action="retry" label="Retry from step" /> },
    { label: 'Resume', node: <IconAction action="resume" label="Resume" /> },
    { label: 'Mark delivered', node: <IconAction action="deliver" label="Mark delivered" /> },
    { label: 'Mark paid…', node: <IconAction action="pay" label="Mark paid…" /> },
    { label: 'Download MP4', node: <IconAction action="download" label="Download MP4" /> },
    { label: 'Review', node: <IconAction action="review" label="Review" /> },
  ];
  return (
    <Section
      title="Row actions"
      note="IconAction · icon-sm (32) · ghost: no fill, outline or shadow, accent background on hover · Tooltip · Hold, Cancel… and Copy error are in the row's right-click menu"
    >
      <div className="flex flex-wrap gap-5">
        {actions.map((action) => (
          <div key={action.label} className="flex w-[72px] flex-col items-center gap-2">
            {action.node}
            <span className="text-center text-xs text-muted-foreground">{action.label}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// Ages from the board's Added / Last updated columns, in minutes before 13:42.
const AGES: readonly [label: string, minutes: number][] = [
  ['under a minute', 0.3],
  ['1 min', 1],
  ['11 min', 11],
  ['1 h', 95],
  ['4 h', 280],
  ['yesterday', 1462],
  ['2 days', 2770],
  ['3 days', 4630],
];

function LiveRelativeTime() {
  // Real clock: starts at "Just now" and ticks over to "1 min ago" within a minute.
  const [iso] = useState(() => new Date(Date.now() - 20_000).toISOString());
  return <RelativeTime iso={iso} />;
}

function RelativeTimeSection() {
  return (
    <Section
      title="Relative time"
      note="RelativeTime · muted text · Tooltip with the exact time · hover or Tab to a value · re-renders every 30 s"
    >
      <div className="grid grid-cols-[96px_1fr] items-center gap-x-4 gap-y-2.5">
        {AGES.map(([label, minutes]) => (
          <div key={label} className="contents">
            <span className="font-mono text-xs text-muted-foreground">{label}</span>
            <div>
              <RelativeTime iso={minutesAgo(minutes)} now={NOW} />
            </div>
          </div>
        ))}
        <span className="border-t pt-2.5 font-mono text-xs text-muted-foreground">live</span>
        <div className="border-t pt-2.5">
          <LiveRelativeTime />
        </div>
      </div>
    </Section>
  );
}

function JobComponents() {
  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.01em]">F3 · Job components</h2>
        <p className="mt-1 text-muted-foreground">
          The app-specific pieces built from the primitives above and the shared formatters. Every
          state from the Components board; the tooltips also open from the keyboard (Tab).
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <JobStatusSection />
        <StatusIconsSection />
        <StepProgressSection />
        <InputsSection />
        <JobActionsSection />
        <RelativeTimeSection />
      </div>
    </>
  );
}

export function ComponentsPage() {
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[1440px] flex-col gap-8 bg-background p-12 text-foreground">
        <div>
          <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Components</h1>
          <p className="mt-1.5 text-muted-foreground">
            shadcn/ui (new-york, zinc, dark) · primary #2563EB · Inter + Noto Sans Hebrew · lucide
            icons · TanStack Table
          </p>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <RowActions />
          <Toolbar />
          <Status />
          <JobCell />
          <TooltipDemo />
          <ColumnsMenu />
          <CancelConfirmation />
          <PaginationAndEmpty />
          <SidebarSection />
        </div>
        <JobComponents />
        <PreviewPlayerGallery />
        <ReviewDialogGallery />
        <GraphicPreviewGallery />
      </main>
    </TooltipProvider>
  );
}
