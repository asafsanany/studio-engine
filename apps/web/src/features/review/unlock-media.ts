// iPhone Safari lets a <video> or <audio> load its data, and play with sound, only once play() was
// called on it during a tap. The player starts the composition's media from inside its iframe, and
// later than the tap: by a message, or after waiting for each video's first frame, which on an
// iPhone never comes before a tap. So the picture stayed black and Play did nothing.
//
// `unlockMedia` runs during the tap, before the player's own play(): it calls play() on each paused
// <video> and <audio> of the composition and pauses it again at once. WebKit lifts an element's
// restrictions at that play() call, and for good, so the video loads and the player plays what the
// composition wants, when it wants. Elsewhere it changes nothing: the element was paused and stays so.
//
// Called outside a tap (the Graphics studio's loop plays from an effect), it does nothing, so a
// later tap still unlocks. A browser without `navigator.userActivation` is taken to be in one.

const unlocked = new WeakSet<HTMLMediaElement>();

/** Unlocks each <video> and <audio> in `doc` once (see above). Call it from a tap or a key press. */
export function unlockMedia(doc: Document | null | undefined): void {
  if (!doc || globalThis.navigator?.userActivation?.isActive === false) return;
  for (const media of doc.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (unlocked.has(media)) continue;
    unlocked.add(media);
    if (!media.paused) continue;
    // The pause rejects this play()'s promise (AbortError), and a blocked one rejects too.
    media.play().catch(() => {});
    media.pause();
  }
}
