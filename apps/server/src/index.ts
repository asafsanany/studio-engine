import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import '@studio/shared';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { openDatabase, type StudioDb } from './db/index.js';
import { createEngine } from './engine.js';
import { logger } from './logger.js';
import { createTailnet } from './remote/tailnet.js';
import { closeServer } from './shutdown.js';

const SHUTDOWN_GRACE_MS = 5_000;

// launchd names the agent's service in this variable, and its KeepAlive starts the engine again
// after it stops. Without the agent (a dev server) nothing would, so Settings cannot restart.
const AGENT_LABEL = 'com.studio-engine.server';

// Resolved from this file, not the cwd, so `pnpm start` works from any directory.
// src/ and dist/ sit at the same depth, so this points at apps/web/dist from either.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

// The repo's git-ignored .env (a variable already in the environment wins). With the Claude billing
// switch on (`claudePlanOnly`, the default) every `claude` run uses the claude.ai plan login and an
// ANTHROPIC_API_KEY found here or in the environment is ignored; with it off, the key is kept.
function loadApiKeyFile(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // No .env file: the environment alone decides.
  }
}

// A bad config or a folder that cannot be created stops the boot here, before anything listens.
function bootConfig(): Config {
  try {
    const config = loadConfig({ log: (message) => logger.warn(message) });
    ensureDirs(config);
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Studio Engine did not start.\n${message}`);
    process.exit(1);
  }
}

// A database that cannot be opened or migrated stops the boot too: nothing works without it.
function bootDatabase(config: Config): StudioDb {
  try {
    return openDatabase(config.dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Studio Engine did not start: cannot open the database at ${config.dbPath}.\n${message}`,
    );
    process.exit(1);
  }
}

const config = bootConfig();
logger.info(
  { inboxPath: config.inboxPath, dataDir: config.dataDir, review: config.review },
  'config loaded',
);

loadApiKeyFile();
const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim() !== '';
if (config.claudePlanOnly) {
  if (hasApiKey) {
    // Plan only (the owner, 25 Oct 2026): the key is dropped from this process too, so nothing started
    // later can inherit it.
    delete process.env.ANTHROPIC_API_KEY;
    logger.warn(
      'ANTHROPIC_API_KEY is set but ignored: Claude runs use the claude.ai plan login only. Turn off "Claude plan only" in Settings to bill the API.',
    );
  } else {
    logger.info('Claude runs use the claude.ai plan login.');
  }
} else if (hasApiKey) {
  logger.warn('"Claude plan only" is off and ANTHROPIC_API_KEY is set: Claude runs bill the API.');
} else {
  logger.warn(
    '"Claude plan only" is off but ANTHROPIC_API_KEY is not set: Claude runs use the claude.ai plan login. Put the key in .env to bill the API.',
  );
}

const db = bootDatabase(config);
logger.info({ dbPath: config.dbPath }, 'database ready');

// The phone opens the engine through Tailscale Serve (Mobile plan §4): who may come in that way is
// the Mac's Tailscale name and owner, read now and every 5 minutes, unless config.json names them.
const tailnet = createTailnet({
  remoteHosts: config.remoteHosts,
  remoteLogins: config.remoteLogins,
  logger,
});
tailnet.start();

// Production serves the built UI from this same process. In dev, Vite serves the UI on :5173
// and proxies /api here.
const engine = createEngine({
  config,
  db,
  logger,
  webDist: process.env.NODE_ENV === 'production' ? WEB_DIST : undefined,
  remoteAccess: tailnet.current,
  settings: {
    // Always under the home folder, even when STUDIO_DATA_DIR moves the data (see config.ts).
    configPath: join(homedir(), '.studio-engine', 'config.json'),
    restart:
      process.env.XPC_SERVICE_NAME === AGENT_LABEL
        ? () => {
            logger.info('restarting: asked on the Settings page');
            process.kill(process.pid, 'SIGTERM');
          }
        : null,
  },
});

// config.host is validated to a loopback address, so this never binds 0.0.0.0.
const server = serve(
  { fetch: engine.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    logger.info({ address: info.address, port: info.port }, 'server listening');
    // Only once the port is ours: a second instance that cannot listen must not start editing.
    engine.start();
  },
) as Server; // serve() returns a union incl. HTTP/2; we only ever create a plain HTTP/1 server.

server.on('error', (err) => {
  logger.error({ err }, 'server error');
  process.exitCode = 1;
  logger.flush();
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  tailnet.stop();

  // Stopping the edit takes a while (the Claude process is killed), so it starts now, alongside
  // closing the server. The database stays open until both are done. Stopping also ends the
  // browsers' event streams.
  const engineStopped = engine.stop().catch((err: unknown) => {
    logger.error({ err }, 'error while stopping the queue worker');
  });

  // The connections of an idle server (a browser's event stream and keep-alive sockets) go as
  // soon as the streams have ended; whatever is still busy after the grace period is cut.
  closeServer(server, {
    graceMs: SHUTDOWN_GRACE_MS,
    onGraceOver: () => logger.warn('grace period over, closing remaining connections'),
  })
    .then(() => {
      logger.info('server closed');
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'error while closing server');
      process.exitCode = 1;
    })
    .then(async () => {
      await engineStopped;
      db.close();
      // Nothing else holds the event loop, so the process exits once the log transport drains.
      logger.flush();
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
