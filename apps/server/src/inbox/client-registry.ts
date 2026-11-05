import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// The clients the engine detects. A folder dropped in the inbox is only a client when it is on
// this list; anything else at that level (a stray `edit/` folder, a copied client) is ignored.
// New client in the app adds to it. It is kept in <dataDir>/clients.json and, the first time,
// filled from the folders that are in the inbox then.

const FILE_NAME = 'clients.json';

const nfc = (name: string): string => name.normalize('NFC');

export class ClientRegistry {
  private readonly names: Set<string>;
  private readonly file: string;

  private constructor(file: string, names: Iterable<string>) {
    this.file = file;
    this.names = new Set([...names].map(nfc));
  }

  /**
   * Reads <dataDir>/clients.json. When there is none yet, starts from `seed()` (the client
   * folders in the inbox now) and saves it. A file that cannot be read counts as none.
   */
  static async open(dataDir: string, seed: () => Promise<string[]>): Promise<ClientRegistry> {
    const file = join(dataDir, FILE_NAME);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const clients = (parsed as { clients?: unknown } | null)?.clients;
      if (Array.isArray(clients)) {
        return new ClientRegistry(
          file,
          clients.filter((name): name is string => typeof name === 'string'),
        );
      }
    } catch {
      // No file, or not JSON: seeded below.
    }
    const registry = new ClientRegistry(file, await seed());
    await registry.save();
    return registry;
  }

  has(name: string): boolean {
    return this.names.has(nfc(name));
  }

  /** Registers a client and saves the list. */
  async add(name: string): Promise<void> {
    if (this.has(name)) return;
    this.names.add(nfc(name));
    await this.save();
  }

  /** Forgets a client (a client renamed away from this name) and saves the list. */
  async remove(name: string): Promise<void> {
    if (!this.names.delete(nfc(name))) return;
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify({ clients: [...this.names].sort() }, null, 2)}\n`);
    await rename(temp, this.file);
  }
}

// The scanner and the watcher both ask this. null: no list, every folder is a client (the tests of
// the inbox, which have no engine around them).
let current: Pick<ClientRegistry, 'has'> | null = null;

/** Sets the list `isRegisteredClient` answers from, or `null` to accept every folder. */
export function useClientRegistry(registry: Pick<ClientRegistry, 'has'> | null): void {
  current = registry;
}

/** False for a folder at the top of the inbox that is not a registered client. */
export function isRegisteredClient(name: string): boolean {
  return current === null || current.has(name);
}
