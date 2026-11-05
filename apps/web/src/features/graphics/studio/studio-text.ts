// The words of a graphic's page (Graphics plan, "Studio"; board GRStudio), in one place. The
// engine's own sentences (a busy graphic, a name taken, a file refused) are GRAPHIC_MESSAGES in
// the shared package and are shown as the server sends them.

/** The header: the way back, the name, the buttons and the ⋯ menu. */
export const HEADER_TEXT = {
  back: 'Graphics',
  nameLabel: 'Name of the graphic',
  renameTip: 'Rename',
  /** Status of a graphic with no version and no run. */
  notMade: 'Not made yet',
  offForEdits: ' · off for edits',
  showInFinder: 'Show in Finder',
  /** The Finder button before v1 exists. */
  noFolderYet: 'There is nothing to show until v1 is made.',
  more: 'More',
  menuLabel: 'Graphic',
  rename: 'Rename',
  duplicate: 'Duplicate',
  turnOff: 'Turn off for edits',
  turnOn: 'Turn on for edits',
  delete: 'Delete…',
} as const;

/** The chat: the empty state, Claude's rows and the starters. */
export const CHAT_TEXT = {
  label: 'Chat',
  emptyTitle: 'What graphic do you need?',
  emptyHint:
    'Describe it in your own words. If you have a screenshot or a clip of one you like, add it.',
  startFrom: 'Or start from',
  claude: 'Claude',
  stop: 'Stop',
  retry: 'Retry',
  copyError: 'Copy error',
  copied: 'Copied',
  /** Under the chip of a version that was made without a run, or whose time is not known: nothing. */
  nothingMade: 'Nothing was made yet.',
  /** When Retry waits for the run that is making. */
  retryWaits: 'Retry once the version being made is done.',
  /** While Stop or Retry is on its way to the engine. */
  working: 'Working on it…',
} as const;

/** The composer. */
export const COMPOSER_TEXT = {
  labelFirst: 'Describe the graphic you need',
  labelNext: 'Ask for a change',
  placeholderFirst: 'Describe the graphic you need…',
  placeholderNext: 'Ask for a change…',
  attach: 'Add a reference: a screenshot, a clip or a logo',
  remove: 'Remove',
  recordStart: 'Record a voice note',
  recordStop: 'Stop recording',
  effortTip: 'How hard Claude works on it',
  effortMenu: 'Effort',
  send: 'Send',
  sending: 'Sending…',
  /** The engine cannot be reached: the composer and its buttons wait. */
  offline: 'Waiting for the engine…',
  /** Send while a recording is on its way. */
  finishRecordingFirst: 'Finish or cancel the recording first',
} as const;

/** What the voice note says while it is not yet text. */
export const VOICE_LINES = {
  waiting: 'Waiting for the microphone…',
  recording: 'Recording · press the mic again to stop',
  saving: 'Typing out your voice note…',
  retry: 'Try again',
  discard: 'Discard',
} as const;

/** The About column. */
export const ABOUT_TEXT = {
  label: 'About this graphic',
  beforeV1: 'Its text, when edits use it, and its details show here once v1 is ready.',
  textTitle: 'Text in it',
  textHint: 'Each edit fills these from its video. Type here to try other text.',
  noText: 'This graphic has no text to change.',
  whenTitle: 'When edits use it',
  whenHint: 'The editor reads this to decide. A job’s note can also ask for it by name.',
  whenLabel: 'When edits use it',
  usesLabel: 'Edits can use it',
  detailsTitle: 'Details',
  noVideos: 'No videos yet',
} as const;

/** The states that replace the studio. */
export const STATE_TEXT = {
  goneTitle: 'This graphic is gone',
  goneHint: 'It was deleted, or it never existed.',
  goneLink: 'Back to Graphics',
  unreachable: "Can't reach the engine.",
  tryAgain: 'Try again',
} as const;

/** The four starters of an empty chat: a label, the request it fills in, and its icon (24 × 24). */
export interface Starter {
  id: 'lower-third' | 'callout' | 'title' | 'end-card';
  label: string;
  request: string;
  /** The `d` of the icon's path(s), drawn with a 2 px stroke like Lucide's. */
  icon: string;
}

export const STARTERS: readonly Starter[] = [
  {
    id: 'lower-third',
    label: 'A lower third for a name',
    request:
      'A lower third: the person’s name on a white pill and their role under it. It slides in from the right, stays about 3 seconds and slides out. Hebrew and English.',
    icon: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 15h18',
  },
  {
    id: 'callout',
    label: 'A big number that counts up',
    request: 'A big number that counts up from zero, with a short label under it. Bold and clean.',
    icon: 'M4 9h16 M4 15h16 M10 3 8 21 M16 3l-2 18',
  },
  {
    id: 'title',
    label: 'An opening title',
    request: 'An opening title that rises word by word, centred, in Hebrew.',
    icon: 'M4 7V4h16v3 M9 20h6 M12 4v16',
  },
  {
    id: 'end-card',
    label: 'An end card with a Follow button',
    request: 'An end card: the client’s handle and a Follow button on a white card that pops in.',
    icon: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7',
  },
];
