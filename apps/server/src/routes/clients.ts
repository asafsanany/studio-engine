// The clients API (Phase 2 plan §1 and §4), mounted at /api/clients. A client is a folder directly
// in the inbox, with jobs or without, and its id is `clientIdFor`. With `folders` (the client
// folders the engine keeps, see ClientFolders):
//
//   GET  /                   (an editor gets their own clients only)
//                            [{ clientId, client, jobs, lastJobAt, style: { state, updatedAt } }],
//                            one row per client folder, sorted by name; `jobs` counts the jobs the
//                            engine knows for it and `lastJobAt` is the newest one's addedAt
//   POST /                   { name } makes `<inbox>/<name>/` and its `_Style/` and answers the new
//                            row (201). The name is trimmed and NFC; 400 with a plain message for
//                            one that is empty, over 80 characters, has / or :, hidden characters, double spaces, or starts with . or
//                            _; 409 when the inbox has that name already (NFC or NFD). Never makes
//                            a job. The row is announced as `client.added`, as a Finder-made one is
//
// and, with `rename` (the admin's, see clients/rename-client.ts):
//
//   PUT  /:clientId/name     { name } renames the client: its folder in the inbox, its exports
//                            folder, its history and logs, and every row about it and its jobs move
//                            to the new name, and so do the ids that are hashes of it (the client's,
//                            its jobs', its series'). Answers the row under the new name. 400 for a
//                            name New client would refuse, 404 for a client without a folder, 409
//                            while one of its jobs is arriving, queued or being edited (or the
//                            engine works in it), its style is being read or a series learned, or
//                            when the name is taken. The old client is announced as
//                            `client.removed`, the new one as `client.added`, and its jobs as
//                            `job.remove` and `job.upsert`
//
// and, with `remove` (the admin's, see clients/delete-client.ts):
//
//   DELETE /:clientId        deletes the client: its folder and its exports go to the Trash (or to
//                            `<data>/deleted-clients` when macOS will not take them), and its jobs,
//                            their deliveries and payments, its series, its style, its logs and
//                            its history are deleted. Answers { clientId, client, trashed }. 404
//                            for a client without a folder, 409 while it is busy (as Rename) or
//                            when a folder could not be moved. The client is announced as
//                            `client.removed`, its jobs as `job.remove`
//
// and for every client the engine knows (a folder, a job or a stored style):
//
//   GET  /:clientId/style    the client's style: { clientId, client, state, version, updatedAt,
//                            error, sourceJobId, markdown }, `markdown` being `_Style/style.md`
//                            or null while that file is not there; 404 unknown client
//   POST /:clientId/reveal   opens the client's folder in Finder; 404 unknown client or a folder
//                            that is gone, 500 when Finder could not be asked
//
// and, with `styles` (the Read pass, Phase 2 plan §5):
//
//   POST /:clientId/style/files  multipart: `files[]` and `mode` (add or replace, default add).
//                                The files are streamed into `_Style` (a taken name gets " (1)")
//                                and a Read pass is queued, in create mode when there is no
//                                style.md. Answers the ClientStyle, now analysing. 404 unknown
//                                client, 409 while it is analysing, 413 above 2 GB in all, 400 for
//                                a body that is not multipart, has no file or another mode
//   POST /:clientId/style/retry  runs the failed style run again (its `last_pass`) and answers the
//                                ClientStyle; 409 unless the style failed
//   POST /:clientId/style/undo   puts the newest style kept in history back (and its kit, if it
//                                has one), adds 1 to the version and answers the ClientStyle; 409
//                                when nothing was kept or while the client is analysing. While a
//                                Learn pass of the client is queued or running (Use this look) it
//                                cancels the pass instead: the style stays as it was, same version,
//                                and the ClientStyle answered is ready again
//
// Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type ClientListResponse,
  type ClientStyle,
  type ClientStyleResponse,
  type CreateClientResponse,
  createClientRequestSchema,
  type DeleteClientResponse,
  noClientStyle,
  normalizeClientName,
  type RenameClientResponse,
  type RevealClientResponse,
  renameClientRequestSchema,
  type Viewer,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import {
  AddStyleFilesError,
  addStyleFiles,
  CLIENT_FOLDER_MISSING,
  STYLE_BEING_ANALYSED,
} from '../clients/add-style-files.js';
import type { ClientFolders } from '../clients/client-folders.js';
import {
  type ClientListSources,
  CreateClientError,
  clientRow,
  createClientFolder,
  listClients,
} from '../clients/client-list.js';
import {
  DeleteClientError,
  type DeleteClientOptions,
  deleteClient,
} from '../clients/delete-client.js';
import { type ClientSources, findClient } from '../clients/lookup.js';
import { clientDirFor, styleDirFor, styleFileFor } from '../clients/paths.js';
import {
  RenameClientError,
  type RenameClientOptions,
  renameClient,
} from '../clients/rename-client.js';
import type { StyleDrops } from '../clients/style-drops.js';
import { REQUESTED_READ_MODES, type RequestedReadMode } from '../clients/style-pass.js';
import {
  MAX_STYLE_UPLOAD_BYTES,
  receiveUpload,
  StyleUploadError,
  UPLOAD_TOO_LARGE,
} from '../clients/style-upload.js';
import { StyleRefusedError, type StyleWorker } from '../clients/style-worker.js';
import { type JobRepository, toClientStyle } from '../db/index.js';
import { clientIdFor } from '../inbox/scan.js';
import { logger } from '../logger.js';
import type { AppEnv } from '../remote/viewer.js';
import { type CanSee, clientFilter } from '../team/viewer-scope.js';

/** Shows a folder to the user. Injected, so tests never open Finder. */
export type FolderOpener = (path: string) => Promise<void>;

const execFileAsync = promisify(execFile);

/** The real opener: macOS `open <folder>`, which brings the folder up in Finder. */
export const openInFinder: FolderOpener = async (path) => {
  await execFileAsync('open', [path]);
};

/** What the style routes need: the worker that runs the passes, and the Finder side to tell. */
export interface StyleRouteOptions {
  worker: Pick<StyleWorker, 'enqueue' | 'retry' | 'undo'>;
  /** Hears of every file an upload puts in `_Style`, so the Finder drops don't read it again. */
  uploads?: Pick<StyleDrops, 'expectUpload'>;
  /** The most one upload may carry. Default 2 GB; tests use less. */
  maxUploadBytes?: number;
}

export interface ClientsRouteOptions extends ClientSources {
  jobs: Pick<JobRepository, 'clientNames' | 'clientJobStats'>;
  /**
   * The client folders of the inbox: they make the list and New client, and let a client without
   * jobs have a style page. Left out by tests that don't need them.
   */
  folders?: Pick<ClientFolders, 'find' | 'list' | 'add' | 'remove'> &
    Partial<Pick<ClientFolders, 'whenSeeded'>>;
  /** The inbox root, `Config.inboxPath`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: a name that would be taken for it is refused. */
  exportsDir?: string;
  /** Registers a new client before its folder is made, so the watcher detects it. */
  registerClient?: (name: string) => Promise<void>;
  /**
   * Told of every client New client made, with who made it, so an editor's client is theirs
   * (team/team-service.ts, `autoAssign`).
   */
  onClientCreated?: (client: CreateClientResponse, creator: Viewer) => void;
  /** Required, so that nothing builds these routes by accident with a real Finder behind them. */
  openFolder: FolderOpener;
  /** The style routes (upload, retry). Left out by tests that don't need them. */
  styles?: StyleRouteOptions;
  /** Which clients a viewer sees (Team plan); the app passes it. An editor's list holds only theirs. */
  canSee?: CanSee;
  /**
   * Each row's `instagram` (Clients × Instagram, IG6). Given only while the `instagram` switch is
   * on; left out, a row has no `instagram` at all.
   */
  instagram?: ClientListSources['instagram'];
  /**
   * Rename (`PUT /:clientId/name`): everything a rename moves besides what these options have.
   * Left out, the route is not there.
   */
  rename?: Omit<RenameClientOptions, 'inboxPath' | 'clientStyles' | 'folders'>;
  /**
   * Delete (`DELETE /:clientId`): everything a delete removes besides what these options have.
   * Left out, the route is not there.
   */
  remove?: Omit<DeleteClientOptions, 'inboxPath' | 'clientStyles' | 'folders'>;
}

/** What an editor is told when the name is taken by a client that is not theirs (the same words as a reserved name). */
const NAME_NOT_AVAILABLE = 'That name is kept for the engine. Try another.';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** The text of `style.md`, or null when there is no such file. */
async function readStyleMarkdown(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The upload's `mode` field: add when left out, null when it is something else. */
function requestedMode(value: string | null): RequestedReadMode | null {
  if (value === null || value === '') return 'add';
  const mode = REQUESTED_READ_MODES.find((known) => known === value);
  return mode ?? null;
}

export function createClientsRoutes(options: ClientsRouteOptions): Hono {
  const { inboxPath, openFolder } = options;
  const routes = new Hono();

  const notFound = (clientId: string) => ({ error: `Client ${clientId} not found` });

  const { folders } = options;
  if (folders !== undefined) {
    routes.get('/', async (c) => {
      // Right after the engine starts the folders are not listed yet: wait for them rather than
      // answer with no clients, which the page would keep until a reload.
      await folders.whenSeeded?.();
      // An editor's list holds their clients only (Team plan, TM2).
      const visible = clientFilter(c, options.canSee);
      const all = listClients({ ...options, folders });
      const body: ClientListResponse =
        visible === null ? all : all.filter((row) => visible(row.clientId));
      return c.json(body);
    });

    routes.post('/', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Send the client name as JSON: { "name": "..." }.' }, 400);
      }
      const request = createClientRequestSchema.safeParse(body);
      if (!request.success) return c.json({ error: 'Give the client a name.' }, 400);

      try {
        const name = await createClientFolder(
          {
            inboxPath,
            exportsDir: options.exportsDir,
            register: options.registerClient,
            folders,
            onStyleDirFailed: (err, folder) =>
              logger.warn({ err, folder }, 'could not make the style folder of a new client'),
          },
          request.data.name,
        );
        const row: CreateClientResponse = clientRow(options, name);
        // The app's viewer middleware has set the viewer (routes mounted alone, as in tests, have none).
        const viewer = (c as unknown as Context<AppEnv>).get('viewer');
        if (viewer !== undefined) options.onClientCreated?.(row, viewer);
        return c.json(row, 201);
      } catch (err) {
        if (err instanceof CreateClientError) {
          // A name that is taken by something the editor cannot see is answered like a name the
          // engine keeps for itself: never a sign that another client has it.
          const visible = clientFilter(c, options.canSee);
          if (
            err.status === 409 &&
            visible !== null &&
            !visible(clientIdFor(normalizeClientName(request.data.name)))
          ) {
            return c.json({ error: NAME_NOT_AVAILABLE }, 400);
          }
          return c.json({ error: err.message }, err.status);
        }
        throw err;
      }
    });
  }

  const { rename } = options;
  if (folders !== undefined && rename !== undefined) {
    routes.put('/:clientId/name', async (c) => {
      const badBody = { error: 'Send the name as JSON: { "name": "New name" }.' };
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(badBody, 400);
      }
      const request = renameClientRequestSchema.safeParse(body);
      if (!request.success) return c.json(badBody, 400);
      try {
        const name = await renameClient(
          {
            ...rename,
            inboxPath,
            clientStyles: options.clientStyles,
            folders,
          },
          c.req.param('clientId'),
          request.data.name,
        );
        const row: RenameClientResponse = clientRow(options, name);
        return c.json(row);
      } catch (err) {
        if (err instanceof RenameClientError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    });
  }

  const { remove } = options;
  if (folders !== undefined && remove !== undefined) {
    routes.delete('/:clientId', async (c) => {
      const clientId = c.req.param('clientId');
      try {
        const { client, trashed } = await deleteClient(
          { ...remove, inboxPath, clientStyles: options.clientStyles, folders },
          clientId,
        );
        const body: DeleteClientResponse = { clientId, client, trashed };
        return c.json(body);
      } catch (err) {
        if (err instanceof DeleteClientError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    });
  }

  routes.get('/:clientId/style', async (c) => {
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, options);
    if (client === null) return c.json(notFound(clientId), 404);

    const stored = options.clientStyles.get(clientId);
    const style = stored === null ? noClientStyle(clientId, client) : toClientStyle(stored);
    const markdown = await readStyleMarkdown(styleFileFor(inboxPath, client));
    const body: ClientStyleResponse = { ...style, client, markdown };
    return c.json(body);
  });

  routes.post('/:clientId/reveal', async (c) => {
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, options);
    if (client === null) return c.json(notFound(clientId), 404);

    const folder = clientDirFor(inboxPath, client);
    if (!(await isDirectory(folder))) {
      return c.json({ error: 'The client folder is missing.' }, 404);
    }
    try {
      await openFolder(folder);
    } catch (err) {
      logger.error({ err, clientId, folder }, 'could not open the client folder');
      return c.json({ error: 'Could not open the folder in Finder.' }, 500);
    }
    const body: RevealClientResponse = { ok: true };
    return c.json(body);
  });

  if (options.styles !== undefined) addStyleRoutes(routes, options, options.styles);

  return routes;
}

function addStyleRoutes(routes: Hono, options: ClientsRouteOptions, styles: StyleRouteOptions) {
  const { inboxPath } = options;
  const { worker, uploads } = styles;
  const maxBytes = styles.maxUploadBytes ?? MAX_STYLE_UPLOAD_BYTES;
  const notFound = (clientId: string) => ({ error: `Client ${clientId} not found` });

  routes.post('/:clientId/style/files', async (c) => {
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, options);
    if (client === null) return c.json(notFound(clientId), 404);
    // Answered before the body is read; `addStyleFiles` asks again once the files are in.
    if (options.clientStyles.get(clientId)?.state === 'analysing') {
      return c.json({ error: STYLE_BEING_ANALYSED }, 409);
    }
    const length = Number(c.req.header('content-length'));
    if (Number.isFinite(length) && length > maxBytes)
      return c.json({ error: UPLOAD_TOO_LARGE }, 413);
    // Never made here: a client folder that is gone stays gone.
    if (!(await isDirectory(clientDirFor(inboxPath, client)))) {
      return c.json({ error: CLIENT_FOLDER_MISSING }, 404);
    }

    const styleDir = styleDirFor(inboxPath, client);
    const stagingDir = join(styleDir, `.upload-${randomUUID()}`);
    try {
      await mkdir(stagingDir, { recursive: true });
      const upload = await receiveUpload(c.req.raw, { stagingDir, maxBytes });
      const mode = requestedMode(upload.mode);
      if (mode === null) return c.json({ error: 'The mode must be add or replace.' }, 400);
      if (upload.files.length === 0) return c.json({ error: 'No files were sent.' }, 400);

      // The files are in the staging folder already: `addStyleFiles` takes them from there.
      const { style } = await addStyleFiles(
        { inboxPath, clientStyles: options.clientStyles, worker, uploads, logger },
        {
          clientId,
          client,
          files: upload.files.map((file) => ({
            name: file.name,
            write: (path) => rename(file.path, path),
          })),
          mode,
          whileAnalysing: 'refuse',
        },
      );
      return c.json(style);
    } catch (err) {
      if (err instanceof StyleUploadError || err instanceof AddStyleFilesError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warn({ err, stagingDir }, 'could not remove the upload staging folder');
      });
    }
  });

  routes.post('/:clientId/style/retry', async (c) => {
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, options);
    if (client === null) return c.json(notFound(clientId), 404);
    try {
      const body: ClientStyle = toClientStyle(await worker.retry(client));
      return c.json(body);
    } catch (err) {
      if (err instanceof StyleRefusedError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  routes.post('/:clientId/style/undo', async (c) => {
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, options);
    if (client === null) return c.json(notFound(clientId), 404);
    try {
      const body: ClientStyle = toClientStyle(await worker.undo(client));
      return c.json(body);
    } catch (err) {
      if (err instanceof StyleRefusedError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });
}
