// The studio's side columns (GR7): the chat on the left, About on the right, the preview between.
// Both are sized from the studio row's own width (`@container` on that row, so `100cqw` is the
// row). Above about 1250 px of window they are the board's 400 px and 300 px. Below that they
// shrink together in a 4 : 3 split of the room the preview leaves, and the preview keeps 330 px (the
// room its Size and Behind it toggles need) down to about 1080 px of window. Narrower than that the
// chat and About stop at 300 px and 220 px, and the toggles wrap inside their track instead.

/** The chat column: 400 px, down to 300 px. */
export const CHAT_COLUMN_WIDTH = 'w-[clamp(300px,calc((100cqw_-_330px)*4/7),400px)]';

/** The About column: 300 px, down to 220 px. */
export const ABOUT_COLUMN_WIDTH = 'w-[clamp(220px,calc((100cqw_-_330px)*3/7),300px)]';
