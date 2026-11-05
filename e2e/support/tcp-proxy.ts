// A TCP proxy in front of the engine that a test can cut and restore, standing for the Mac going to
// sleep or leaving the tailnet. Cut, it drops every open connection (the events stream breaks) and
// refuses new ones, as a Mac that is off the tailnet does. `context.setOffline` is no use for this:
// it leaves a stream that is already open alone.

import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';

/** Starts a proxy to `target` (the engine's `baseURL`) on a free loopback port. */
export async function startProxy(target: URL) {
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let port = 0;

  const accept = (client: Socket) => {
    const upstream = connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const next = createServer(accept);
      next.once('error', reject);
      next.listen(port, '127.0.0.1', () => {
        port = (next.address() as AddressInfo).port;
        server = next;
        resolve();
      });
    });

  async function cut(): Promise<void> {
    const closing = server;
    server = null;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => (closing ? closing.close(() => resolve()) : resolve()));
  }

  await listen();
  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    cut,
    restore: listen,
    close: cut,
  };
}
