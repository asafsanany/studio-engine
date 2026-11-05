import { describe, expect, it } from 'vitest';
import { isInstagramPage, itemsOfMessage, kindOfInstagramLink, linksIn } from './parse.js';

// What a message holds. The shapes are the ones Instagram's documents show (the Conversations
// API's `shares` and `attachments`, the webhook's `{ type, payload }`); the CDN links are made up.

const CDN_VIDEO = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=abc';
const CDN_IMAGE = 'https://scontent.cdninstagram.com/v/t51/photo.jpg?sig=1';

describe('itemsOfMessage', () => {
  it('reads a shared reel from `shares`, with its caption and its file', () => {
    const items = itemsOfMessage({
      id: 'm1',
      shares: { data: [{ type: 'ig_reel', name: 'Sunset drone cut', url: CDN_VIDEO, id: '17' }] },
    });
    expect(items).toEqual([
      { kind: 'reel', title: 'Sunset drone cut', text: null, link: null, mediaUrl: CDN_VIDEO },
    ]);
  });

  it('reads the webhook shape of a reel (`type` and `payload`)', () => {
    const items = itemsOfMessage({
      attachments: { data: [{ type: 'ig_reel', payload: { url: CDN_VIDEO, title: 'Hook' } }] },
    });
    expect(items).toEqual([
      { kind: 'reel', title: 'Hook', text: null, link: null, mediaUrl: CDN_VIDEO },
    ]);
  });

  it('gives a share without its file the attachment that is the file, as one item', () => {
    const items = itemsOfMessage({
      message: 'for Falcon',
      shares: {
        data: [{ type: 'reel', link: 'https://www.instagram.com/reel/DfBUU0nDswI/', name: 'Cut' }],
      },
      attachments: { data: [{ video_data: { url: CDN_VIDEO } }] },
    });
    expect(items).toEqual([
      {
        kind: 'reel',
        title: 'Cut',
        text: 'for Falcon',
        link: 'https://www.instagram.com/reel/DfBUU0nDswI/',
        mediaUrl: CDN_VIDEO,
      },
    ]);
  });

  it('does not list an attachment twice when it is the share’s own file', () => {
    const items = itemsOfMessage({
      shares: { data: [{ type: 'ig_post', url: CDN_IMAGE }] },
      attachments: { data: [{ image_data: { url: CDN_IMAGE } }] },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('post');
  });

  it('reads photos, voice notes and files by what they are', () => {
    const items = itemsOfMessage({
      attachments: {
        data: [
          { image_data: { url: CDN_IMAGE } },
          { audio_data: { url: 'https://cdn.fbsbx.com/a.mp4' } },
          { file_url: 'https://cdn.fbsbx.com/song.mp3', mime_type: 'audio/mpeg', name: 'song.mp3' },
          { file_url: 'https://cdn.fbsbx.com/brief.pdf', mime_type: 'application/pdf' },
        ],
      },
    });
    expect(items.map((item) => item.kind)).toEqual(['photo', 'audio', 'audio', 'file']);
    expect(items[2]?.title).toBe('song.mp3');
  });

  it('reads a story mention as a story with its file', () => {
    const items = itemsOfMessage({ story: { mention: { link: CDN_IMAGE, id: 's1' } } });
    expect(items).toEqual([
      { kind: 'story', title: null, text: null, link: null, mediaUrl: CDN_IMAGE },
    ]);
  });

  it('makes each link in the words an item: a sound, a reel, a post or any link', () => {
    const items = itemsOfMessage({
      message:
        'this sound https://www.instagram.com/reels/audio/1043357377036343/ and https://www.instagram.com/reel/DfBUU0nDswI/?igsh=x, also https://open.spotify.com/track/1.',
    });
    expect(items.map((item) => [item.kind, item.link])).toEqual([
      ['audio', 'https://www.instagram.com/reels/audio/1043357377036343/'],
      ['reel', 'https://www.instagram.com/reel/DfBUU0nDswI/?igsh=x'],
      ['link', 'https://open.spotify.com/track/1'],
    ]);
    expect(items.every((item) => item.text?.startsWith('this sound'))).toBe(true);
  });

  it('makes words alone one message item', () => {
    expect(itemsOfMessage({ message: '  the song from the gym video  ' })).toEqual([
      {
        kind: 'text',
        title: null,
        text: 'the song from the gym video',
        link: null,
        mediaUrl: null,
      },
    ]);
  });

  it('says when Instagram could not pass a message on, and skips an empty one', () => {
    expect(itemsOfMessage({ is_unsupported: true })).toEqual([
      { kind: 'unsupported', title: null, text: null, link: null, mediaUrl: null },
    ]);
    expect(itemsOfMessage({ id: 'm1', created_time: '2026-10-30T10:00:00+0000' })).toEqual([]);
  });
});

describe('links', () => {
  it('tells Instagram pages from files on its CDN', () => {
    expect(isInstagramPage('https://www.instagram.com/p/abc/')).toBe(true);
    expect(isInstagramPage('https://instagram.com/reel/abc')).toBe(true);
    expect(isInstagramPage('https://scontent.cdninstagram.com/v/x.jpg')).toBe(false);
    expect(isInstagramPage('not a link')).toBe(false);
  });

  it('names what an Instagram link points at', () => {
    expect(kindOfInstagramLink('https://www.instagram.com/reels/audio/1/')).toBe('audio');
    expect(kindOfInstagramLink('https://www.instagram.com/reel/abc/')).toBe('reel');
    expect(kindOfInstagramLink('https://www.instagram.com/reels/abc/')).toBe('reel');
    expect(kindOfInstagramLink('https://www.instagram.com/p/abc/')).toBe('post');
    expect(kindOfInstagramLink('https://www.instagram.com/stories/x/1/')).toBe('story');
    expect(kindOfInstagramLink('https://www.instagram.com/falcon.fpv/')).toBe('link');
  });

  it('finds links in words without the punctuation after them', () => {
    expect(linksIn('see (https://a.example/x), and https://b.example/y!')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
  });
});
