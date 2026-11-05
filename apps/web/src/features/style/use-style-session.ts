import type { ClientStyleResponse } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, applyClientStyle, clientStyleKey } from '@/data';
import { createDropTarget } from './drop-target';
import { createStyleSession, type StyleSession } from './style-session';

/**
 * The upload session of a client's Style page (see style-session.ts): one per client, kept while
 * the page is open (the page is keyed by the client). It reads the cached style, puts the upload's
 * answer in it, and, whenever the style changes, asks the session whether the run of its upload
 * has ended.
 */
export function useStyleSession(style: ClientStyleResponse) {
  const queryClient = useQueryClient();
  const { clientId } = style;

  // One session for as long as the page of this client is open (`StyleView` is keyed by the client).
  const [session] = useState<StyleSession>(() =>
    createStyleSession({
      getStyle: () => queryClient.getQueryData<ClientStyleResponse>(clientStyleKey(clientId)),
      upload: ({ files, mode, onProgress }) =>
        api.uploadStyleFiles(clientId, { files, mode, onProgress }),
      onUploaded: (answer) => applyClientStyle(queryClient, answer),
    }),
  );
  useEffect(() => () => session.dispose(), [session]);

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  // `state.started` is a dependency too: the run may have ended before the upload's answer came in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the style's state and version are the triggers; `observe` reads the cache itself
  useEffect(() => {
    session.observe();
  }, [session, style.state, style.version, state.started]);

  return { session, state };
}

/**
 * Whether files are being dragged over the window, and what to do with a drop: `onFiles`. The
 * listeners are on the window so that a drop that just misses the page's box is still ours (the
 * browser would otherwise open the file and leave the app).
 */
export function useWindowDrops(onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(onFiles);
  latest.current = onFiles;

  useEffect(() => {
    const target = createDropTarget({
      onFiles: (files) => latest.current(files),
      onDragging: setDragging,
    });
    const listeners = [
      ['dragenter', target.dragenter],
      ['dragover', target.dragover],
      ['dragleave', target.dragleave],
      ['drop', target.drop],
    ] as const;
    for (const [type, listener] of listeners) window.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    };
  }, []);

  return dragging;
}
