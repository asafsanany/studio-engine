// The team: who besides the owner may open the engine, and which clients each editor sees (Team plan,
// TM0). It lives in <dataDir>/team.json:
//
//   { "users": [{ "email": "yael@example.com", "name": "Yael", "role": "editor" }],
//     "assignments": { "<clientId>": { "client": "Acme", "editors": ["yael@example.com"] } } }
//
// The owner, the Mac's owner, is the admin and is not stored. A client with no editors is for the
// admin only. Several editors may share a client.
//
// The file is read again whenever it changes on disk (checked on every question, one `stat`), so
// adding Yael by hand or through the API needs no restart. Writes are atomic: a temp file in the
// same folder, then a rename. A file that cannot be read keeps what was last good; a missing one
// is an empty team.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type TeamAssignment,
  type TeamFile,
  type TeamRole,
  type TeamUser,
  teamFileSchema,
} from '@studio/shared';

const normaliseEmail = (email: string): string => email.trim().toLowerCase();
const nfc = (name: string): string => name.normalize('NFC');

export interface TeamServiceOptions {
  /** Told when team.json exists but cannot be used (bad JSON or shape); the last good team stays. */
  onUnreadable?: (err: unknown) => void;
}

export class TeamService {
  private state: TeamFile = { users: [], assignments: {} };
  /** `mtime:size` of the file as last read or written; `null` for none. */
  private seen: string | null = null;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly options: TeamServiceOptions = {},
  ) {}

  // --- reading ---------------------------------------------------------------------------------

  /** Everyone on the team (not the owner). */
  users(): TeamUser[] {
    this.refresh();
    return this.state.users.map((user) => ({ ...user }));
  }

  /** The logins of the whole team, lowercase: what the access guard lets in besides the owner. */
  emails(): string[] {
    this.refresh();
    return this.state.users.map((user) => user.email);
  }

  find(email: string): TeamUser | undefined {
    this.refresh();
    const key = normaliseEmail(email);
    const user = this.state.users.find((candidate) => candidate.email === key);
    return user === undefined ? undefined : { ...user };
  }

  /** The editors of a client, lowercase. Empty: the admin only. */
  editorsOf(clientId: string): string[] {
    this.refresh();
    return [...(this.state.assignments[clientId]?.editors ?? [])];
  }

  /** The assignments with their client names, by client id. */
  assignments(): Record<string, TeamAssignment> {
    this.refresh();
    return structuredClone(this.state.assignments);
  }

  /** The ids of the clients an editor is assigned to. */
  clientIdsOf(email: string): string[] {
    this.refresh();
    const key = normaliseEmail(email);
    return Object.entries(this.state.assignments)
      .filter(([, assignment]) => assignment.editors.includes(key))
      .map(([clientId]) => clientId);
  }

  /** Whether someone with this role and login may see a client. An unassigned client is admin-only. */
  canSee(viewer: { email: string; role: TeamRole }, clientId: string): boolean {
    if (viewer.role === 'admin') return true;
    return this.editorsOf(clientId).includes(normaliseEmail(viewer.email));
  }

  // --- writing ---------------------------------------------------------------------------------

  /** Adds a person, or changes their name and role. */
  upsertUser(user: TeamUser): void {
    this.refresh();
    const next: TeamUser = { email: normaliseEmail(user.email), name: user.name, role: user.role };
    if (next.email === '') throw new Error('A team member needs a login.');
    const users = this.state.users.filter((existing) => existing.email !== next.email);
    users.push(next);
    this.commit({ ...this.state, users });
  }

  /** Removes a person and every assignment of theirs. */
  removeUser(email: string): void {
    this.refresh();
    const key = normaliseEmail(email);
    this.commit({
      users: this.state.users.filter((user) => user.email !== key),
      assignments: mapAssignments(this.state.assignments, (a) => ({
        ...a,
        editors: a.editors.filter((editor) => editor !== key),
      })),
    });
  }

  /** Sets who the editors of a client are, replacing the list. An empty list: the admin only. */
  setEditors(clientId: string, client: string, editors: readonly string[]): void {
    this.refresh();
    const assignments = { ...this.state.assignments };
    const list = [...new Set(editors.map(normaliseEmail).filter((email) => email !== ''))];
    if (list.length === 0) delete assignments[clientId];
    else assignments[clientId] = { client: nfc(client), editors: list };
    this.commit({ ...this.state, assignments });
  }

  /**
   * A client that someone just created: when an editor made it, it is theirs. The admin's and a
   * stranger's clients stay unassigned (the admin sees every client anyway). Returns whether the
   * client was assigned.
   */
  autoAssign(
    clientId: string,
    client: string,
    creator: { email: string; role: TeamRole },
  ): boolean {
    if (creator.role !== 'editor') return false;
    this.refresh();
    const email = normaliseEmail(creator.email);
    const current = this.state.assignments[clientId]?.editors ?? [];
    if (current.includes(email)) return true;
    this.setEditors(clientId, client, [...current, email]);
    return true;
  }

  /** Forgets a client's assignment (the client is gone). Returns whether there was one to forget. */
  removeClient(clientId: string): boolean {
    this.refresh();
    if (this.state.assignments[clientId] === undefined) return false;
    const assignments = { ...this.state.assignments };
    delete assignments[clientId];
    this.commit({ ...this.state, assignments });
    return true;
  }

  // --- the file --------------------------------------------------------------------------------

  private fingerprint(): string | null {
    try {
      const info = statSync(this.file);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return null;
    }
  }

  /** Reads the file again when it is not the one last seen. */
  private refresh(): void {
    const now = this.fingerprint();
    if (this.loaded && now === this.seen) return;
    this.loaded = true;
    this.seen = now;
    if (now === null) {
      this.state = { users: [], assignments: {} };
      return;
    }
    try {
      const parsed = teamFileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.state = {
        users: dedupe(parsed.users),
        assignments: parsed.assignments,
      };
    } catch (err) {
      // Keep the last good team: a half-saved edit must not lock the editors out (or in).
      this.options.onUnreadable?.(err);
    }
  }

  private commit(next: TeamFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, this.file);
    this.state = next;
    this.seen = this.fingerprint();
    this.loaded = true;
  }
}

function dedupe(users: readonly TeamUser[]): TeamUser[] {
  const byEmail = new Map<string, TeamUser>();
  for (const user of users) byEmail.set(user.email, user);
  return [...byEmail.values()];
}

function mapAssignments(
  assignments: TeamFile['assignments'],
  change: (assignment: TeamAssignment) => TeamAssignment,
): TeamFile['assignments'] {
  const next: TeamFile['assignments'] = {};
  for (const [clientId, assignment] of Object.entries(assignments)) {
    const changed = change(assignment);
    if (changed.editors.length > 0) next[clientId] = changed;
  }
  return next;
}
