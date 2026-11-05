// The graphics service (Graphics plan, "API"). OWNER: GR1. Everything the graphics routes
// (routes/graphics.ts) ask: every method answers a `GraphicOutcome`, the body to send with its
// status or a refusal with its status and words (GRAPHIC_MESSAGES), so a route maps it without
// knowing any rule:
//
//   const outcome = await graphics.rename(id, name);
//   return outcome.ok ? c.json(outcome.body, outcome.status) : c.json({ error: outcome.error }, outcome.status);
//
//   method                    route                                          ok    refusals
//   list()                    GET    /api/graphics                           200
//   get(id)                   GET    /api/graphics/:id                       200   404
//   create(send)              POST   /api/graphics                           201   400, 413
//   send(id, send)            POST   /api/graphics/:id/messages              202   400, 404, 409 making, 413
//   stop(id, mid)             POST   /api/graphics/:id/messages/:mid/stop    200   404, 409
//   retry(id, mid)            POST   /api/graphics/:id/messages/:mid/retry   202   404, 409
//   restore(id, n)            POST   /api/graphics/:id/versions/:n/restore   200   404, 409
//   update(id, patch)         PUT    /api/graphics/:id                       200   400, 404, 409, 422
//   duplicate(id)             POST   /api/graphics/:id/duplicate             201   404, 409
//   reveal(id)                POST   /api/graphics/:id/reveal                200   404, 500
//   remove(id)                DELETE /api/graphics/:id                       200   404, 500
//
// While the Graphics switch is off the engine mounts no graphics route (app.ts answers 404
// "Graphics are off." for all of them) and uses `createDisabledGraphicService()`, which refuses
// everything the same way.
//
// Everything that changes one graphic (send, retry, restore, rename, duplicate, delete) takes that
// graphic's turn, so two of them never interleave across a file copy; new folders in `_Graphics`
// (a new graphic, a copy) take one turn of their own, so two never pick the same name. Stop does
// not wait for a turn: it is what ends a run.
//
// A message may be only attachments: its text is 0 to 4000 characters, and it needs the text or
// at least one file (GRAPHIC_MESSAGES.textMissing).

import {
  cleanGraphicName,
  type DeleteGraphicResponse,
  type Effort,
  freeGraphicName,
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  type GraphicBusyAction,
  type GraphicDetail,
  type GraphicListResponse,
  graphicBusyMessage,
  graphicCopiedText,
  graphicCopyName,
  graphicNameKey,
  graphicRestoredText,
  NEW_GRAPHIC_NAME,
  type RevealGraphicResponse,
  type UpdateGraphicRequest,
} from '@studio/shared';
import {
  GraphicNameEmptyError,
  GraphicNameTakenError,
  type GraphicRepository,
  type StoredGraphic,
  toGraphicMessage,
} from '../db/index.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { type FolderOpener, openInFinder } from '../routes/clients.js';
import { readGraphicAbout } from './graphic-check.js';
import {
  type GraphicFolders,
  graphicVersionDir,
  type ReceivedGraphicFile,
} from './graphic-folders.js';
import type { GraphicEvent, GraphicWorker } from './graphic-worker.js';

/** A refusal: the status to answer with and the words for the person, sent as `{ error }`. */
export interface GraphicRefusal {
  ok: false;
  status: 400 | 404 | 409 | 413 | 415 | 422 | 500;
  error: string;
}

/** What a graphics method answers: the body to send and its status, or a refusal. */
export type GraphicOutcome<Body> =
  | { ok: true; status: 200 | 201 | 202; body: Body }
  | GraphicRefusal;

/** A message the owner sends: its text (checked with graphicMessageFieldsSchema), effort and files. */
export interface GraphicSend {
  /** Trimmed, 0 to 4000 characters; empty only with files. */
  text: string;
  /** `null`: the default (Extra high). */
  effort: Effort | null;
  /** The attached files as the upload received them (at most GRAPHIC_LIMITS.refsMaxFiles). */
  files: readonly ReceivedGraphicFile[];
}

export interface GraphicService {
  /** Whether Graphics are on: false for {@link createDisabledGraphicService}. */
  readonly enabled: boolean;
  /** The graphics that are not empty, newest change first. */
  list(): Promise<GraphicOutcome<GraphicListResponse>>;
  get(id: string): Promise<GraphicOutcome<GraphicDetail>>;
  /**
   * An empty folder for an upload to stage its files in; the caller removes it when the request
   * is over. Staging beside the refs/ folders makes storing a file a rename.
   */
  stagingDir(): Promise<string>;
  /**
   * The refusal `send` would give right now (404 unknown graphic, 409 while it is making), or
   * `null`. The route asks before it reads a body, so a big upload is not taken for nothing.
   */
  sendable(id: string): Promise<GraphicRefusal | null>;
  /** A new graphic ("New graphic …") with the owner's first message, its refs and v1's run queued. */
  create(send: GraphicSend): Promise<GraphicOutcome<GraphicDetail>>;
  /** A message asking for a change; the next version's run is queued. 409 while making. */
  send(id: string, send: GraphicSend): Promise<GraphicOutcome<GraphicDetail>>;
  /** Stop: the run of Claude's row `messageId` is aborted and the row becomes stopped. */
  stop(id: string, messageId: string): Promise<GraphicOutcome<GraphicDetail>>;
  /** Retry: Claude's newest row, when it failed or was stopped, makes its version again. */
  retry(id: string, messageId: string): Promise<GraphicOutcome<GraphicDetail>>;
  /** "Use vN again": a new version copied from v`version`, with no run. */
  restore(id: string, version: number): Promise<GraphicOutcome<GraphicDetail>>;
  /** Rename (moves the folder; 409 while making), the When line, "Edits can use it". */
  update(id: string, patch: UpdateGraphicRequest): Promise<GraphicOutcome<GraphicDetail>>;
  /** "<Name> copy": the version edits use becomes v1 of the copy. Answers the copy. */
  duplicate(id: string): Promise<GraphicOutcome<GraphicDetail>>;
  /** Show in Finder: the graphic's folder. */
  reveal(id: string): Promise<GraphicOutcome<RevealGraphicResponse>>;
  /** Stops a run, moves the folder to the Trash and deletes the graphic. */
  remove(id: string): Promise<GraphicOutcome<DeleteGraphicResponse>>;
}

const OFF: GraphicRefusal = { ok: false, status: 404, error: GRAPHIC_MESSAGES.off };
const NOT_FOUND: GraphicRefusal = { ok: false, status: 404, error: GRAPHIC_MESSAGES.notFound };

/** The service while the Graphics switch is off: every method refuses 404 "Graphics are off.". */
export function createDisabledGraphicService(): GraphicService {
  const off = async (): Promise<GraphicRefusal> => OFF;
  return {
    enabled: false,
    list: off,
    get: off,
    stagingDir: async () => {
      throw new Error(GRAPHIC_MESSAGES.off);
    },
    sendable: off,
    create: off,
    send: off,
    stop: off,
    retry: off,
    restore: off,
    update: off,
    duplicate: off,
    reveal: off,
    remove: off,
  };
}

export interface GraphicServiceOptions {
  repo: GraphicRepository;
  folders: GraphicFolders;
  worker: GraphicWorker;
  /** Every change: the engine publishes it on the bus. */
  publish: (event: GraphicEvent) => void;
  /** The graphicsInEdits switch: off, a graphic's detail has `usedIn: null`. */
  usedIn: boolean;
  /** Opens a folder in Finder (Show in Finder). Default: macOS `open`. */
  openFolder?: FolderOpener;
  logger: WorkerLogger;
  clock?: () => Date;
}

function refuse(status: GraphicRefusal['status'], error: string): GraphicRefusal {
  return { ok: false, status, error };
}

function done<Body>(status: 200 | 201 | 202, body: Body): GraphicOutcome<Body> {
  return { ok: true, status, body };
}

/** The turn that makes new folders in `_Graphics` (a new graphic, a copy). */
const NEW_FOLDER_TURN = '\u0000new-folder';

/** The real service, while the Graphics switch is on. OWNER: GR1. */
export function createGraphicService(options: GraphicServiceOptions): GraphicService {
  const { repo, folders, worker, publish, usedIn, logger } = options;
  const openFolder = options.openFolder ?? openInFinder;
  const clock = options.clock ?? (() => new Date());
  const iso = () => clock().toISOString();

  /** Tells the browsers the graphic changed, with the message that moved (if one did). */
  function announce(graphicId: string, messageId?: string): void {
    const graphic = repo.summary(graphicId);
    if (graphic === null) return;
    const message = messageId === undefined ? null : repo.message(messageId);
    publish({
      type: 'graphic.changed',
      graphic,
      ...(message === null ? {} : { message: toGraphicMessage(message) }),
    });
  }

  /** What changes one graphic goes one at a time, in the order it was asked. */
  const turns = new Map<string, Promise<unknown>>();
  function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (turns.get(key) ?? Promise.resolve()).then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    turns.set(key, settled);
    void settled.then(() => {
      if (turns.get(key) === settled) turns.delete(key);
    });
    return result;
  }

  function detailOutcome(id: string, status: 200 | 201 | 202): GraphicOutcome<GraphicDetail> {
    const detail = repo.detail(id, { usedIn });
    return detail === null ? NOT_FOUND : done(status, detail);
  }

  /** 409 while the graphic is making a version. */
  function busy(id: string, action: GraphicBusyAction): GraphicRefusal | null {
    const summary = repo.summary(id);
    if (summary === null || summary.status !== 'making') return null;
    return refuse(409, graphicBusyMessage(summary.makingVersion ?? 1, action));
  }

  /** The versions that were made (or used again): Claude's rows that are done. */
  function madeVersions(id: string): number[] {
    return repo
      .messages(id)
      .filter((message) => message.role === 'claude' && message.status === 'done')
      .flatMap((message) => (message.version === null ? [] : [message.version]));
  }

  /** The version the next run makes: after the newest one made. */
  function nextVersion(id: string): number {
    return Math.max(0, ...madeVersions(id)) + 1;
  }

  /** What a message can be: text or files, within the limits. */
  function checkSend(send: GraphicSend): GraphicRefusal | null {
    const text = send.text.trim();
    if (text.length > GRAPHIC_LIMITS.textMax) return refuse(400, GRAPHIC_MESSAGES.textTooLong);
    if (text === '' && send.files.length === 0) return refuse(400, GRAPHIC_MESSAGES.textMissing);
    if (send.files.length > GRAPHIC_LIMITS.refsMaxFiles) {
      return refuse(413, GRAPHIC_MESSAGES.tooManyFiles);
    }
    if (send.files.reduce((total, file) => total + file.size, 0) > GRAPHIC_LIMITS.refsMaxBytes) {
      return refuse(413, GRAPHIC_MESSAGES.tooLarge);
    }
    return null;
  }

  /** The names a new folder in `_Graphics` must not take: the graphics' and what is on disk. */
  async function takenNames(): Promise<string[]> {
    return [...repo.liveNames(), ...(await folders.names())];
  }

  /** The owner's message and Claude's making row for `version`, and the run queued. */
  function addTurn(id: string, send: GraphicSend, refs: readonly string[], version: number): void {
    const asked = repo.addMessage({
      graphicId: id,
      role: 'you',
      text: send.text.trim(),
      refs,
      effort: send.effort,
    });
    const making = repo.addMessage({
      graphicId: id,
      role: 'claude',
      version,
      status: 'making',
      step: 0,
    });
    announce(id, asked.id);
    announce(id, making.id);
    worker.enqueue(id, making.id);
  }

  /** Whether a folder by that name (without regard to case) is in `_Graphics` and is not this graphic's. */
  async function folderTaken(name: string, graphic: StoredGraphic): Promise<boolean> {
    if (graphicNameKey(name) === graphicNameKey(graphic.folder)) return false;
    const key = graphicNameKey(name);
    return (await folders.names()).some((folder) => graphicNameKey(folder) === key);
  }

  /** Renames the graphic and its folder; a refusal when the name cannot be used after all. */
  async function rename(graphic: StoredGraphic, name: string): Promise<GraphicRefusal | null> {
    try {
      repo.rename(graphic.id, name, name);
    } catch (err) {
      if (err instanceof GraphicNameEmptyError) return refuse(422, GRAPHIC_MESSAGES.nameEmpty);
      if (err instanceof GraphicNameTakenError) return refuse(422, GRAPHIC_MESSAGES.nameTaken);
      throw err;
    }
    try {
      await folders.rename(graphic.folder, name);
    } catch (err) {
      repo.rename(graphic.id, graphic.name, graphic.folder);
      throw err;
    }
    return null;
  }

  return {
    enabled: true,

    async list() {
      const body = repo.summaries().filter((graphic) => graphic.status !== 'empty');
      return done(200, body);
    },

    async get(id) {
      return detailOutcome(id, 200);
    },

    stagingDir: () => folders.stagingDir(),

    async sendable(id) {
      if (repo.get(id) === null) return NOT_FOUND;
      return busy(id, 'send');
    },

    async create(send) {
      const invalid = checkSend(send);
      if (invalid !== null) return invalid;

      const graphic = await inTurn(NEW_FOLDER_TURN, async () => {
        const name = freeGraphicName(NEW_GRAPHIC_NAME, await takenNames());
        const stored = repo.create({ name });
        try {
          await folders.create(stored.folder);
        } catch (err) {
          repo.softDelete(stored.id);
          throw err;
        }
        return stored;
      });
      try {
        const refs = await folders.storeRefs(graphic.folder, send.files);
        addTurn(graphic.id, send, refs, 1);
      } catch (err) {
        repo.softDelete(graphic.id);
        await folders.discard(graphic.folder).catch(() => undefined);
        throw err;
      }
      return detailOutcome(graphic.id, 201);
    },

    async send(id, send) {
      return inTurn(id, async () => {
        const graphic = repo.get(id);
        if (graphic === null) return NOT_FOUND;
        const refusal = busy(id, 'send') ?? checkSend(send);
        if (refusal !== null) return refusal;
        const refs = await folders.storeRefs(graphic.folder, send.files);
        addTurn(id, send, refs, nextVersion(id));
        return detailOutcome(id, 202);
      });
    },

    async stop(id, messageId) {
      if (repo.get(id) === null) return NOT_FOUND;
      const message = repo.message(messageId);
      if (message === null || message.graphicId !== id) {
        return refuse(404, GRAPHIC_MESSAGES.messageNotFound);
      }
      if (message.role !== 'claude' || message.status !== 'making') {
        return refuse(409, GRAPHIC_MESSAGES.notMaking);
      }
      await worker.stopRun(id, messageId);
      // A row the worker knew nothing of (it should not happen) is stopped here.
      if (repo.message(messageId)?.status === 'making') {
        repo.updateMessage(messageId, { status: 'stopped', step: null, endedAt: iso() });
        announce(id, messageId);
      }
      return detailOutcome(id, 200);
    },

    async retry(id, messageId) {
      return inTurn(id, async () => {
        if (repo.get(id) === null) return NOT_FOUND;
        const message = repo.message(messageId);
        if (message === null || message.graphicId !== id) {
          return refuse(404, GRAPHIC_MESSAGES.messageNotFound);
        }
        const ended =
          message.role === 'claude' &&
          (message.status === 'failed' || message.status === 'stopped');
        if (!ended) return refuse(409, GRAPHIC_MESSAGES.notRetryable);
        const waiting = busy(id, 'retry');
        if (waiting !== null) return waiting;
        // Only the newest of Claude's rows is made again: an older one has been answered since.
        const newest = repo
          .messages(id)
          .filter((row) => row.role === 'claude')
          .at(-1);
        if (newest?.id !== message.id) return refuse(409, GRAPHIC_MESSAGES.notRetryable);

        repo.updateMessage(messageId, {
          status: 'making',
          step: 0,
          version: nextVersion(id),
          text: '',
          error: null,
          startedAt: null,
          endedAt: null,
        });
        announce(id, messageId);
        worker.enqueue(id, messageId);
        return detailOutcome(id, 202);
      });
    },

    async restore(id, version) {
      return inTurn(id, async () => {
        const graphic = repo.get(id);
        if (graphic === null) return NOT_FOUND;
        const waiting = busy(id, 'restore');
        if (waiting !== null) return waiting;
        if (
          !madeVersions(id).includes(version) ||
          !(await folders.hasVersion(graphic.folder, version))
        ) {
          return refuse(404, GRAPHIC_MESSAGES.versionNotFound);
        }
        if (version === graphic.version) return refuse(409, GRAPHIC_MESSAGES.nothingToRestore);

        const to = nextVersion(id);
        await folders.copyVersion(graphic.folder, version, to);
        // What that version said about itself (its text fields, its length) is the graphic's again.
        const about = await readGraphicAbout(
          graphicVersionDir(folders.dirOf(graphic.folder), version),
        );
        const now = iso();
        const row = repo.addMessage({
          graphicId: id,
          role: 'claude',
          version: to,
          status: 'done',
          text: graphicRestoredText(version, to),
          startedAt: now,
          endedAt: now,
        });
        repo.setVersion(id, {
          version: to,
          ...(about.ok
            ? {
                kind: about.about.kind,
                lengthSec: about.about.lengthSec,
                variables: about.about.variables,
                when: about.about.when,
              }
            : {}),
        });
        announce(id, row.id);
        return detailOutcome(id, 200);
      });
    },

    async update(id, patch) {
      return inTurn(id, async () => {
        const graphic = repo.get(id);
        if (graphic === null) return NOT_FOUND;

        let name: string | null = null;
        if (patch.name !== undefined) {
          const clean = cleanGraphicName(patch.name);
          if (clean === '') return refuse(422, GRAPHIC_MESSAGES.nameEmpty);
          if (clean !== graphic.name) {
            const waiting = busy(id, 'rename');
            if (waiting !== null) return waiting;
            const taken = !repo.isNameFree(clean, id) || (await folderTaken(clean, graphic));
            if (taken) return refuse(422, GRAPHIC_MESSAGES.nameTaken);
            name = clean;
          }
        }
        const when = patch.when === undefined ? null : patch.when.trim();
        if (when !== null && when.length > GRAPHIC_LIMITS.whenMax) {
          return refuse(400, GRAPHIC_MESSAGES.whenTooLong);
        }

        if (name !== null) {
          const refusal = await rename(graphic, name);
          if (refusal !== null) return refusal;
        }
        if (when !== null) repo.setWhen(id, when);
        if (patch.uses !== undefined) repo.setUses(id, patch.uses);
        announce(id);
        return detailOutcome(id, 200);
      });
    },

    async duplicate(id) {
      return inTurn(id, async () => {
        const graphic = repo.get(id);
        if (graphic === null) return NOT_FOUND;
        const version = graphic.version;
        if (version === null) return refuse(409, GRAPHIC_MESSAGES.nothingToDuplicate);

        const copy = await inTurn(NEW_FOLDER_TURN, async () => {
          const name = freeGraphicName(
            cleanGraphicName(graphicCopyName(graphic.name)),
            await takenNames(),
          );
          const stored = repo.create({ name });
          try {
            await folders.duplicate(graphic.folder, version, stored.folder, {
              from: graphic.id,
              to: stored.id,
            });
          } catch (err) {
            repo.softDelete(stored.id);
            throw err;
          }
          return stored;
        });
        // The copy starts as the version it was made from said: its fields and its When line.
        repo.setVersion(copy.id, {
          version: 1,
          ...(graphic.kind === null ? {} : { kind: graphic.kind }),
          ...(graphic.lengthSec === null ? {} : { lengthSec: graphic.lengthSec }),
          variables: graphic.variables,
          when: graphic.when,
        });
        if (graphic.whenEdited) repo.setWhen(copy.id, graphic.when);
        const now = iso();
        const row = repo.addMessage({
          graphicId: copy.id,
          role: 'claude',
          version: 1,
          status: 'done',
          text: graphicCopiedText(graphic.name, version),
          startedAt: now,
          endedAt: now,
        });
        announce(copy.id, row.id);
        return detailOutcome(copy.id, 201);
      });
    },

    async reveal(id) {
      const graphic = repo.get(id);
      if (graphic === null) return NOT_FOUND;
      if (!(await folders.has(graphic.folder))) return NOT_FOUND;
      try {
        await openFolder(folders.dirOf(graphic.folder));
      } catch (err) {
        logger.error({ err, graphicId: id }, 'could not open the graphic folder');
        return refuse(500, GRAPHIC_MESSAGES.revealFailed);
      }
      return done(200, { ok: true as const });
    },

    async remove(id) {
      return inTurn(id, async () => {
        const graphic = repo.get(id);
        if (graphic === null) return NOT_FOUND;

        // A run of it ends first, so nothing writes into the folder as it moves.
        const making = worker.makingMessageOf(id);
        if (making !== null) await worker.stopRun(id, making);
        for (const row of repo.messages(id).filter((message) => message.status === 'making')) {
          repo.updateMessage(row.id, { status: 'stopped', step: null, endedAt: iso() });
        }

        let where: string;
        if (await folders.has(graphic.folder)) {
          try {
            const trashed = await folders.trash(graphic.folder);
            where = trashed.where;
            if (!trashed.trashed) {
              logger.warn(
                { graphicId: id, where, reason: trashed.reason },
                'graphic: the Trash would not take the folder; it is kept in the data folder',
              );
            }
          } catch (err) {
            logger.error({ err, graphicId: id }, 'graphic: the folder could not be moved away');
            return refuse(500, GRAPHIC_MESSAGES.deleteFailed);
          }
        } else {
          logger.warn({ graphicId: id }, 'graphic: deleted, but its folder was already gone');
          where = folders.dirOf(graphic.folder);
        }
        repo.softDelete(id);
        publish({ type: 'graphic.removed', id });
        return done(200, { ok: true as const, where });
      });
    },
  };
}
