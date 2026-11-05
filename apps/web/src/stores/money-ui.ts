import { localMonthOf } from '@studio/shared';
import { createStore, useStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { browserStorage, guardStorage } from './jobs-ui';

/**
 * UI state of the Money page, shared by its three parts (the banners, the Ledger and the
 * Expenses). Only the two switches (how the Ledger is grouped and how the Expenses are shown) are
 * remembered per browser; the month, the open row and the pages always start fresh.
 */

/** localStorage key for the persisted switches. Bump the `v1` suffix with the schema. */
export const MONEY_VIEW_STORAGE_KEY = 'studio.money.view.v1';

/** Version of the persisted shape (see `migrate`). */
export const MONEY_VIEW_STORAGE_VERSION = 1;

/** Rows per page, in the Ledger and in the Expenses. */
export const MONEY_PAGE_SIZE = 10;

/** How the Ledger lists its jobs: one row per job, or a header per client with its jobs below. */
export const LEDGER_GROUPINGS = ['job', 'client'] as const;
export type LedgerGrouping = (typeof LEDGER_GROUPINGS)[number];

/** What the Expenses list: one row per thing paid for (Items), or one per payment (All charges). */
export const EXPENSES_VIEWS = ['items', 'charges'] as const;
export type ExpensesView = (typeof EXPENSES_VIEWS)[number];

/**
 * The one open row of the page: a ledger job (`kind: 'job'`, `id` = the job's id) or an expense
 * item (`kind: 'item'`, `id` = the item's id). Opening a row closes whichever other was open,
 * across both tables.
 */
export interface OpenRow {
  kind: 'job' | 'item';
  id: string;
}

export interface MoneyUiState {
  /** The month shown, YYYY-MM. Starts as this month, on this machine's calendar. */
  month: string;
  /** The open row, or `null`. */
  open: OpenRow | null;
  grouping: LedgerGrouping;
  /**
   * In the "By client" grouping, the one open client group. A `clientId` is that client's group;
   * `null` is none, because it was closed; `undefined` (how it starts, and again after another
   * month, another grouping or another page) means nothing was chosen, so the first client on the
   * page is open, as on the board.
   */
  clientOpen: string | null | undefined;
  expensesView: ExpensesView;
  /** Zero-based pages. A page past the last is the table's to clamp (it knows the row count). */
  ledgerPage: number;
  expensesPage: number;
}

export interface MoneyUiActions {
  /** Shows another month: the open row, the open client and both pages start over. */
  setMonth(month: string): void;
  /** Opens `row`, or closes it when it is the one that is open. Any other open row closes. */
  toggleOpen(row: OpenRow): void;
  /** Opens the client group `clientId` (any other closes), or closes the open one with `null`. */
  setClientOpen(clientId: string | null): void;
  /** Another grouping starts the Ledger over from its first page. */
  setGrouping(grouping: LedgerGrouping): void;
  /** Another view starts the Expenses over from their first page. */
  setExpensesView(view: ExpensesView): void;
  setLedgerPage(page: number): void;
  setExpensesPage(page: number): void;
}

export type MoneyUiStore = MoneyUiState & MoneyUiActions;

/** The slice that survives a reload. */
export interface PersistedMoneyView {
  grouping: LedgerGrouping;
  expensesView: ExpensesView;
}

/** This month on this machine's calendar (the month the server answers for with no `?month=`). */
export function currentMonth(now: number = Date.now()): string {
  let timeZone = 'UTC';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // No time zone to read: UTC is the closest guess.
  }
  try {
    return localMonthOf(now, timeZone);
  } catch {
    return localMonthOf(now, 'UTC');
  }
}

export function defaultMoneyUiState(month: string = currentMonth()): MoneyUiState {
  return {
    month,
    open: null,
    grouping: 'job',
    clientOpen: undefined,
    expensesView: 'items',
    ledgerPage: 0,
    expensesPage: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A page number is a whole number, never below the first page. */
function toPage(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** The persisted switches from untrusted input (localStorage is user-editable). */
function toPersistedView(value: unknown): PersistedMoneyView {
  const stored = isRecord(value) ? value : {};
  return {
    grouping: LEDGER_GROUPINGS.find((g) => g === stored.grouping) ?? 'job',
    expensesView: EXPENSES_VIEWS.find((v) => v === stored.expensesView) ?? 'items',
  };
}

/** zustand `migrate`: version 1 is the first shape; any other version falls back to the defaults. */
export function migratePersistedView(persisted: unknown, version: number): PersistedMoneyView {
  return version === MONEY_VIEW_STORAGE_VERSION
    ? toPersistedView(persisted)
    : toPersistedView(undefined);
}

/**
 * Build a Money UI store. `storage` is injectable so tests can simulate a reload by creating a
 * second store over the same storage; `month` is what the store starts on (default: this month).
 */
export function createMoneyUiStore(
  storage: StateStorage = browserStorage(),
  month: string = currentMonth(),
) {
  return createStore<MoneyUiStore>()(
    persist(
      (set) => ({
        ...defaultMoneyUiState(month),

        setMonth: (next) =>
          set((s) =>
            next === s.month
              ? s
              : {
                  month: next,
                  open: null,
                  clientOpen: undefined,
                  ledgerPage: 0,
                  expensesPage: 0,
                },
          ),
        toggleOpen: (row) =>
          set((s) => ({
            open: s.open?.kind === row.kind && s.open.id === row.id ? null : { ...row },
          })),
        setClientOpen: (clientId) => set({ clientOpen: clientId }),
        setGrouping: (grouping) =>
          set((s) =>
            grouping === s.grouping ? s : { grouping, ledgerPage: 0, clientOpen: undefined },
          ),
        setExpensesView: (expensesView) =>
          set((s) => (expensesView === s.expensesView ? s : { expensesView, expensesPage: 0 })),
        setLedgerPage: (page) =>
          set((s) => {
            const ledgerPage = toPage(page);
            // Another page has other clients on it: its first one is open again.
            return ledgerPage === s.ledgerPage ? s : { ledgerPage, clientOpen: undefined };
          }),
        setExpensesPage: (page) =>
          set((s) => {
            const expensesPage = toPage(page);
            return expensesPage === s.expensesPage ? s : { expensesPage };
          }),
      }),
      {
        name: MONEY_VIEW_STORAGE_KEY,
        version: MONEY_VIEW_STORAGE_VERSION,
        storage: createJSONStorage(() => guardStorage(storage)),
        // Only the two switches are remembered; the month, the open row and the pages are per visit.
        partialize: (s): PersistedMoneyView => ({
          grouping: s.grouping,
          expensesView: s.expensesView,
        }),
        migrate: (persisted, version) => migratePersistedView(persisted, version),
        merge: (persisted, current) => ({ ...current, ...toPersistedView(persisted) }),
      },
    ),
  );
}

/** The app-wide store, persisted to this browser's localStorage. */
export const moneyUiStore = createMoneyUiStore();

export function useMoneyUiStore<T>(selector: (state: MoneyUiStore) => T): T {
  return useStore(moneyUiStore, selector);
}
