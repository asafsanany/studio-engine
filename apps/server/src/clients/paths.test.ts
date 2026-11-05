import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { clientIdFor, seriesIdFor } from '../inbox/scan.js';
import {
  clientDirFor,
  historyDirFor,
  instagramPhotoFor,
  instagramPhotosDirFor,
  SERIES_FILE_NAME,
  STYLE_FILE_NAME,
  seriesDirFor,
  seriesFileFor,
  seriesHistoryDirFor,
  seriesHistoryFileFor,
  seriesHistoryKitDirFor,
  seriesKitDirFor,
  seriesRootFor,
  styleDirFor,
  styleFileFor,
} from './paths.js';

describe('client paths', () => {
  const inbox = '/Users/owner/Studio Inbox';

  it('puts the style folder inside the client folder, in the inbox', () => {
    expect(clientDirFor(inbox, 'Arc Fitness')).toBe('/Users/owner/Studio Inbox/Arc Fitness');
    expect(styleDirFor(inbox, 'Arc Fitness')).toBe('/Users/owner/Studio Inbox/Arc Fitness/_Style');
    expect(styleFileFor(inbox, 'Arc Fitness')).toBe(
      '/Users/owner/Studio Inbox/Arc Fitness/_Style/style.md',
    );
    expect(STYLE_FILE_NAME).toBe('style.md');
  });

  it('keeps the client name exactly as given, Hebrew and NFD included', () => {
    expect(styleDirFor(inbox, 'מאפיית הצפון')).toBe(join(inbox, 'מאפיית הצפון', '_Style'));
    const nfd = 'Café'.normalize('NFD');
    expect(styleDirFor(inbox, nfd)).toBe(join(inbox, nfd, '_Style'));
  });

  it('keeps the history of a client under <dataDir>/clients/<clientId>/history', () => {
    const id = clientIdFor('Arc Fitness');
    expect(historyDirFor('/Users/owner/.studio-engine', id)).toBe(
      `/Users/owner/.studio-engine/clients/${id}/history`,
    );
  });

  it('follows the config, so a test that points the config at a temp folder never touches the real one', () => {
    const config = loadConfig({ home: '/tmp/fake-home', env: {} });
    const id = clientIdFor('Arc Fitness');

    expect(styleDirFor(config.inboxPath, 'Arc Fitness')).toBe(
      '/tmp/fake-home/Studio Inbox/Arc Fitness/_Style',
    );
    expect(historyDirFor(config.dataDir, id)).toBe(
      `/tmp/fake-home/.studio-engine/clients/${id}/history`,
    );

    const moved = loadConfig({
      home: '/tmp/fake-home',
      env: { STUDIO_INBOX: '/tmp/elsewhere/Inbox', STUDIO_DATA_DIR: '/tmp/elsewhere/data' },
    });
    expect(styleDirFor(moved.inboxPath, 'Arc Fitness')).toBe(
      '/tmp/elsewhere/Inbox/Arc Fitness/_Style',
    );
    expect(historyDirFor(moved.dataDir, id)).toBe(`/tmp/elsewhere/data/clients/${id}/history`);
  });
});

describe('Instagram photo path', () => {
  it('keeps a client’s picture at <dataDir>/instagram/photos/<clientId>.jpg', () => {
    const id = clientIdFor('Falcon FPV');
    expect(instagramPhotosDirFor('/Users/owner/.studio-engine')).toBe(
      '/Users/owner/.studio-engine/instagram/photos',
    );
    expect(instagramPhotoFor('/Users/owner/.studio-engine', id)).toBe(
      `/Users/owner/.studio-engine/instagram/photos/${id}.jpg`,
    );
  });

  it('follows the data folder the config says', () => {
    const config = loadConfig({ home: '/tmp/fake-home', env: {} });
    expect(instagramPhotoFor(config.dataDir, 'abc123def456')).toBe(
      '/tmp/fake-home/.studio-engine/instagram/photos/abc123def456.jpg',
    );

    const moved = loadConfig({
      home: '/tmp/fake-home',
      env: { STUDIO_DATA_DIR: '/tmp/elsewhere/data' },
    });
    expect(instagramPhotoFor(moved.dataDir, 'abc123def456')).toBe(
      '/tmp/elsewhere/data/instagram/photos/abc123def456.jpg',
    );
  });
});

describe('series paths', () => {
  const inbox = '/Users/owner/Studio Inbox';
  const client = 'עו״ד דוד לוי';

  it('puts each series in its own folder under the client’s _Series', () => {
    expect(seriesRootFor(inbox, client)).toBe(join(inbox, client, '_Series'));
    expect(seriesDirFor(inbox, client, 'מיתוס או אמת')).toBe(
      join(inbox, client, '_Series', 'מיתוס או אמת'),
    );
    expect(seriesFileFor(inbox, client, 'מיתוס או אמת')).toBe(
      join(inbox, client, '_Series', 'מיתוס או אמת', 'series.md'),
    );
    expect(seriesKitDirFor(inbox, client, 'מיתוס או אמת')).toBe(
      join(inbox, client, '_Series', 'מיתוס או אמת', 'kit'),
    );
    expect(SERIES_FILE_NAME).toBe('series.md');
  });

  it('keeps a series’ history under <dataDir>/clients/<clientId>/series/<seriesId>/history', () => {
    const clientId = clientIdFor(client);
    const seriesId = seriesIdFor(clientId, 'מיתוס או אמת');
    const history = `/Users/owner/.studio-engine/clients/${clientId}/series/${seriesId}/history`;
    expect(seriesHistoryDirFor('/Users/owner/.studio-engine', clientId, seriesId)).toBe(history);
    expect(seriesHistoryFileFor('/Users/owner/.studio-engine', clientId, seriesId, 2)).toBe(
      `${history}/2.md`,
    );
    expect(seriesHistoryKitDirFor('/Users/owner/.studio-engine', clientId, seriesId, 2)).toBe(
      `${history}/2-kit`,
    );
  });
});
