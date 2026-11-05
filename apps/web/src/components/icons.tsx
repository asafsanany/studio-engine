import { createLucideIcon } from 'lucide-react';

// The design canvas draws its icons from an older release of Lucide than the one this app
// installs. Lucide has since redrawn a handful of them (thicker Pause bars, a rounded Play, a
// larger Square, an extra line in File text, new List video, Settings and Clapperboard outlines),
// so the same-named icon from `lucide-react` no longer matches the approved boards pixel for
// pixel. These are the canvas's own paths, with the same Lucide names and class names
// (`lucide-pause`, ...), so they drop in wherever the app used the package's icon. Every other
// icon on the boards (Video, Mic, Image, Copy, Download, the chevrons, the sort arrows, ...) is
// drawn identically by the installed release and still comes from `lucide-react`.

export const Clapperboard = createLucideIcon('clapperboard', [
  [
    'path',
    { d: 'M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z', key: 'a' },
  ],
  ['path', { d: 'm6.2 5.3 3.1 3.9', key: 'b' }],
  ['path', { d: 'm12.4 3.4 3.1 4', key: 'c' }],
  ['path', { d: 'M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', key: 'd' }],
]);

export const FileText = createLucideIcon('file-text', [
  ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', key: 'a' }],
  ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4', key: 'b' }],
  ['path', { d: 'M16 13H8', key: 'c' }],
  ['path', { d: 'M16 17H8', key: 'd' }],
]);

export const ListVideo = createLucideIcon('list-video', [
  ['path', { d: 'M12 12H3', key: 'a' }],
  ['path', { d: 'M16 6H3', key: 'b' }],
  ['path', { d: 'M12 18H3', key: 'c' }],
  ['path', { d: 'm16 12 5 3-5 3v-6Z', key: 'd' }],
]);

export const Pause = createLucideIcon('pause', [
  ['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1', key: 'a' }],
  ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1', key: 'b' }],
]);

export const Play = createLucideIcon('play', [['path', { d: 'M6 4l14 8-14 8z', key: 'a' }]]);

export const Settings = createLucideIcon('settings', [
  [
    'path',
    {
      d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
      key: 'a',
    },
  ],
  ['circle', { cx: '12', cy: '12', r: '3', key: 'b' }],
]);

export const Square = createLucideIcon('square', [
  ['rect', { x: '5', y: '5', width: '14', height: '14', rx: '2', key: 'a' }],
]);
