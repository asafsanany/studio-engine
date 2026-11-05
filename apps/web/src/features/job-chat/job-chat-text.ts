/** The words of a job's chat (Draft & chat, board DCDialog). */
export const JOB_CHAT_TEXT = {
  emptyTitle: 'Nothing here yet',
  emptyHint:
    'Once the draft starts, everything it does shows up here: what it reads, the pictures it looks at, the plan, the cut list and each preview. You can write notes now; they wait for cut 1.',
  loading: 'Loading the chat…',
  failed: 'Couldn’t load the chat.',
  retry: 'Try again',
  understood: 'What I understood',
  transcript: 'Transcript',
  plan: 'Plan',
  cuts: 'Cut list',
  loudness: 'Loudness',
  showAll: 'Show all',
  showLess: 'Show less',
  open: 'Open',
  stop: 'Stop',
  stopping: 'Stopping…',
  notSent: 'Not sent yet',
  notesWait: 'Notes open when the cut is ready.',
  waitingInLine: 'Waiting in line',
  noCutYet: 'Cut 1 shows here when it’s ready.',
  folded: 'Show what it did',
  hideFolded: 'Hide',
  stoppedDraft: 'You stopped the draft. What it made so far is kept.',
  stoppedRun: 'This run was stopped. What it made so far is kept.',
  close: 'Close',
  previous: 'Previous picture',
  next: 'Next picture',
} as const;

/** The progress box's title, by stage. */
export const DRAFT_PROGRESS_TITLE = 'Drafting';
