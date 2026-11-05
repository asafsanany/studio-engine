/**
 * Where Approve is, said wherever Review has no notes left to send: it is in the row's right-click
 * menu only, never inside the job (the owner, 31 Oct: an editor approved to see the video sooner, then
 * unapproved). The phone has no right-click: holding the row opens its sheet, which is that menu.
 * The Mac's words are in the lines; `onPhone` puts the phone's in their place.
 */
export const APPROVE_WHERE = {
  mac: 'Approve it from the job’s right-click menu',
  phone: 'Press and hold the job in the list and choose Approve',
} as const;

/** A Review line with the Mac's `APPROVE_WHERE` in it, said the phone's way. */
export function onPhone(text: string): string {
  return text.replace(APPROVE_WHERE.mac, APPROVE_WHERE.phone);
}

/** The review dialog's words (canvas, Phase 3: P3Review). */
export const REVIEW_DIALOG_TEXT = {
  livePreview: 'Live preview',
  videoPreview: 'Preview video',
  downloadPreview: 'Download the preview video',
  // The phone shares the preview instead (U16): the icon, while it fetches the MP4, and the words
  // under it where the browser can't share a file.
  sharePreview: 'Share the preview video',
  gettingPreview: 'Getting the preview video…',
  makingPreviewVideo: 'Making the preview video… it opens here when it is ready.',
  livePreviewTip: 'This plays the live edit. The final video renders after you approve.',
  exportMp4: 'Export MP4',
  exportMaking: 'Rendering…',
  exportSave: 'Save MP4',
  exportTip:
    'Renders the full-quality video now. Approving then uses it instead of rendering again.',
  exportReadyTip: 'The full-quality video is ready. Approving uses it as it is.',
  exportFailed: 'Export failed. Try again.',
  manualEdit: 'Manual edit',
  soon: 'Soon',
  manualEditTip: 'The manual editing page comes later',
  close: 'Close',
  closeTip: 'Close (Esc)',
  /** Screen readers only: the dialog's description. */
  description:
    'The live preview of this edit. Leave notes and send them. To render the final video, approve it from the job’s right-click menu.',
  notes: 'Notes',
  /** Toast: the job left Review while its dialog was open. */
  left: 'This job is no longer in Review.',
  /** Toast: the Effort button's change was refused (the server's reason follows). */
  effortFailed: 'Could not change the effort',
} as const;

/** The notes list and its cards. */
export const NOTES_TEXT = {
  empty: 'No notes yet. Pause where something should change, then write or record a note below.',
  /** On the phone the Write and Record buttons are not below the list. */
  emptyPhone: 'No notes yet. Pause where something should change, then write or record a note.',
  loading: 'Loading the notes…',
  loadFailed: "Couldn't load the notes.",
  retry: 'Try again',
  voiceTag: 'Voice note',
  addToStyle: 'Add to style',
  inStyle: 'In style',
  addToStyleTip: 'Also save this change to the client style, for every future job',
  inStyleTip: 'Remove from the client style',
  styleLine: 'When you send, this also goes into the style of',
  /** On an episode of a series (board SeriesNotes) the two toggles are short: Series and Style. */
  series: 'Series',
  inSeries: 'In series',
  addToSeriesTip: 'Add to series: also change every later episode',
  inSeriesTip: 'Keep this to this episode only',
  episodeStyle: 'Style',
  episodeStyleTip: 'Add to style: also save this for every future job of this client',
  seriesLine: 'When you send, this also goes into every later episode of',
  /** The phone's line (board MReviewSeries) names the series, as its row's mark does. */
  seriesLinePhone: 'When you send, this also goes into the series',
  deleteNote: 'Delete note',
  styleFailed: "Couldn't change Add to style",
  seriesFailed: "Couldn't change Add to series",
  deleteFailed: "Couldn't delete the note",
} as const;

/**
 * Quick fixes in Review (canvas page "Quick fixes", boards QFReview and QFStates): the line under
 * a note that answers it, and the footer's words while fixes are on. The curly apostrophe is the
 * board's. `{n}`, `{who}`, `{why}` and `{time}` are filled in by `fix-lines.ts`.
 */
export const FIX_TEXT = {
  /** The line under a note. */
  reading: 'Reading the note…',
  queued: 'Quick fix · next in line',
  running: 'Fixing it now',
  /** After the words, with a space: " · Changing the caption font". */
  runningStep: ' · ',
  /** "Fixed in 38 s." then the run's reply. */
  fixedIn: 'Fixed in {n} s.',
  fixed: 'Fixed.',
  goesWithSend: 'Goes with Send',
  /** After the words: "Goes with Send · it changes the cut". */
  goesWithSendWhy: ' · ',
  couldNot: 'Couldn’t do it here: {why}. It goes with Send.',
  couldNotNoWhy: 'Couldn’t do it here. It goes with Send.',
  undone: 'Undone. It goes to the editor when you send.',
  undo: 'Undo',
  undoTip: 'Put it back the way it was',
  /** The footer, a note being read or a fix queued or running. */
  footReading: 'Reading the note.',
  footFixingOne: 'Fixing it here.',
  footFixingMany: 'Fixing {n} notes here, one at a time.',
  sendWaits: ' Send waits for it.',
  approveWaits: ' Approve waits for it.',
  waitTip: 'Wait for the fix to finish',
  /** The footer, notes that wait for Send on Auto. `{time}` is a range ("12 to 40 min"), or "about 5 min" when both ends are the same. */
  autoSends: 'Auto sends {notes} to {who}{why}, {time}.',
  autoWhole: ' (one changes the whole video)',
  /** The time of a round of notes: the job's own shortest and longest, else the tier's. */
  minutesRange: '{min} to {max} min',
  minutesAbout: 'about {n} min',
  /** The footer, notes that wait for Send on a level instead of Auto: the level is named. */
  levelSends: 'Your notes go to the editor together, at {level}.',
  /** The footer, only fixed notes. */
  fixedOne: `Fixed here. ${APPROVE_WHERE.mac} to render the final video, or keep writing notes.`,
  fixedAll: `All {n} fixed here. ${APPROVE_WHERE.mac} to render the final video.`,
  /** What a model without a name is called ("the editor at Extra high"). */
  theEditor: 'the editor',
} as const;

/** The composer under the list. */
export const COMPOSER_TEXT = {
  label: 'New note at',
  placeholder: 'Write a note… the video pauses while you type',
  record: 'Record',
  recordTip: 'Record a voice note (R)',
  comment: 'Comment',
  commentTip: 'Add the note (Enter)',
} as const;

/** The footer: Send with notes; with none, the line says where Approve is (`APPROVE_WHERE`). */
export const FOOTER_TEXT = {
  withNotes: 'Your notes go to the editor together.',
  /** The start of the line with no notes; what Approve renders follows ("… the final video."). */
  approveLead: `Happy with it? ${APPROVE_WHERE.mac} to render`,
  withoutNotes: `Happy with it? ${APPROVE_WHERE.mac} to render the final video.`,
  approve: 'Approve',
  /** Toast after Approve. */
  approved: 'Approved. The final video is rendering; the job shows Ready when it is done.',
  /** The end of the toast after Send. */
  sentTail: 'The job comes back to Review when the changes are done.',
} as const;

/** Voice notes: the recording box, the voice note card and Send while a transcript is on its way. */
export const VOICE_TEXT = {
  recording: 'Recording', // "Recording 0:07"
  pinnedAt: 'pinned at', // "pinned at 0:02"
  waitingForMic: 'Waiting for the microphone…',
  saving: 'Adding the voice note…',
  cancel: 'Cancel',
  cancelTip: 'Cancel (Esc)',
  stopAndAdd: 'Stop and add',
  stopAndAddTip: 'Stop and add (R)',
  discard: 'Discard',
  retry: 'Try again',
  micDenied: 'Microphone access is off. Allow it in the browser to record voice notes.',
  noMic: 'No microphone was found.',
  unsupported: "This browser can't record voice notes.",
  /** Followed by a space and the browser's message. */
  startFailed: "Couldn't start recording:",
  empty: 'The recording is empty.',
  /** Followed by a space and the server's message. */
  uploadFailed: "Couldn't add the voice note:",
  play: 'Play voice note',
  pause: 'Pause voice note',
  transcribing: 'Transcribing…',
  notTranscribed: "Couldn't transcribe. The editor will listen to it.",
  waitingForTranscripts: 'Waiting for the voice notes to be transcribed',
  /** Send's tooltip while a recording is starting, running, uploading or waiting for Try again. */
  finishRecordingFirst: 'Finish or cancel the recording first',
  /** The red pin's accessible name: "Recording at 0:02". */
  recordingAt: 'Recording at',
} as const;
