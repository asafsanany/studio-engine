import type { Job } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ComponentType, useEffect, useMemo, useState } from 'react';
import type { StoreApi } from 'zustand';
import { api, useMarkPaid } from '@/data';
import { rowFocusTarget } from '../row-focus';
import { MarkPaidDialog, type MarkPaidDialogProps } from './MarkPaidDialog';
import { type MarkPaidDeps, payOwed } from './mark-paid-changes';
import {
  allTicked,
  confirmLabel,
  initialTicked,
  isPaidOnAllowed,
  owedJobs,
  paidAmounts,
  payRows,
  type TypedAmounts,
  tickedJobs,
  todayLocal,
  toggleAll,
  toggleTicked,
  totalLabel,
  typeAmount,
} from './pay-list';
import {
  type MarkPaidRequest,
  type MarkPaidRequestState,
  markPaidRequestStore,
  useMarkPaidRequest,
} from './request';

interface MarkPaidDialogHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** Where the request lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<MarkPaidRequestState>;
  /**
   * What draws the question: the Mac's dialog by default; the phone shell passes its bottom sheet
   * (`PhoneMarkPaidSheet`). It gets the same props, so the rules stay in one place.
   */
  view?: ComponentType<MarkPaidDialogProps>;
}

/**
 * The "Mark paid · <client>" dialog for the whole Jobs page (and a client's page, which shares the
 * table). A delivered row's banknote button and its menu's "Mark paid…" only ask
 * (`askToMarkPaid`); the dialog and its payment live here, one level above the table, so they
 * survive the row moving to another page.
 *
 * - It lists the client's delivered, unpaid videos from the live job list, newest delivery first,
 *   with the video it was asked for ticked. Each has the amount paid for it, its price until the
 *   person types another (₪0 included); typing an amount ticks the video. If that video is no longer delivered it opens anyway
 *   with whatever is still unpaid (nothing ticked), and it does not open, or closes, when nothing
 *   is.
 * - "Mark N paid" sends the payment and closes the dialog. A message says how many videos from the
 *   client were marked paid, for how much, with Undo (see `mark-paid-changes.ts`).
 * - A refusal (409: a video changed meanwhile) keeps the dialog open with a short line under the
 *   list; the list is loaded again, so it shows what is left.
 * - Closing gives focus to the row's action button, or to the row itself, when the row is on the
 *   page (there is no trigger element to give it back to).
 *
 * Mount it once, on the page, next to `UseLookDialogHost` (the messages are drawn by the toaster);
 * under the phone layout, once in the shell (`PhoneJobSheetHost`) with the phone's sheet as `view`.
 * Renders nothing until a row has asked.
 */
export function MarkPaidDialogHost({
  jobs,
  store = markPaidRequestStore,
  view = MarkPaidDialog,
}: MarkPaidDialogHostProps) {
  const { request, close } = useMarkPaidRequest(store);

  // The newest request, kept after it is closed: the dialog still fades out with its words, and
  // each new request is a new session, so its ticks, day and error start again.
  const [shown, setShown] = useState<{ request: MarkPaidRequest; session: number } | null>(null);
  if (request !== null && request !== shown?.request) {
    setShown({ request, session: (shown?.session ?? 0) + 1 });
  }

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().close(), [store]);

  if (shown === null) return null;
  return (
    <MarkPaidSession
      key={shown.session}
      request={shown.request}
      open={request !== null}
      jobs={jobs}
      onClose={close}
      view={view}
    />
  );
}

interface MarkPaidSessionProps {
  request: MarkPaidRequest;
  /** The request is still wanted: the dialog shows (or fades out when this turns `false`). */
  open: boolean;
  jobs: readonly Job[] | undefined;
  onClose: () => void;
  view: ComponentType<MarkPaidDialogProps>;
}

/** One asking of the dialog: its ticks, amounts, day, whether it is saving and what went wrong. */
function MarkPaidSession({ request, open, jobs, onClose, view: View }: MarkPaidSessionProps) {
  const owed = useMemo(() => owedJobs(jobs, request.clientId), [jobs, request.clientId]);
  // Ticks start with the video that was asked for (if it is still owed) and then are the person's.
  const [ticked, setTicked] = useState(() => initialTicked(owed, request.jobId));
  const [typed, setTyped] = useState<TypedAmounts>(() => new Map());
  const [today] = useState(() => todayLocal());
  const [paidOn, setPaidOn] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = useMarkPaid();
  const queryClient = useQueryClient();
  const deps: MarkPaidDeps = { markPaid: pay.mutateAsync, api, queryClient };

  // Nothing (left) to pay: there is nothing to ask, so the request is dropped. Not while the list
  // has not loaded, and not while a payment is on its way (it empties the list itself).
  const loaded = jobs !== undefined;
  useEffect(() => {
    if (open && loaded && owed.length === 0 && !saving) onClose();
  }, [open, loaded, owed.length, saving, onClose]);

  const picked = tickedJobs(owed, ticked);
  const amounts = paidAmounts(picked, typed);
  const paidOnValid = isPaidOnAllowed(paidOn, today);
  const canConfirm = picked.length > 0 && paidOnValid && amounts !== null;

  const change = (next: () => void) => {
    // What the last attempt said no longer describes what is on screen.
    setError(null);
    next();
  };

  const confirm = async () => {
    if (saving || !canConfirm || amounts === null) return;
    setSaving(true);
    setError(null);
    const outcome = await payOwed(deps, request, picked, paidOn, amounts);
    if (outcome.ok) {
      // Stay "saving" while it fades out: the dialog does not wake up with its old ticks.
      onClose();
    } else {
      setError(outcome.message);
      setSaving(false);
    }
  };

  return (
    <View
      // Not shown at all while there is nothing to list: no flash before it closes again.
      open={open && (owed.length > 0 || saving)}
      client={request.client}
      rows={payRows(owed, ticked, undefined, typed)}
      allTicked={allTicked(owed, ticked)}
      paidOn={paidOn}
      today={today}
      paidOnValid={paidOnValid}
      total={totalLabel(picked, typed)}
      confirm={confirmLabel(picked.length)}
      canConfirm={canConfirm}
      saving={saving}
      error={error}
      onToggle={(jobId) => change(() => setTicked((now) => toggleTicked(now, jobId)))}
      onToggleAll={() => change(() => setTicked((now) => toggleAll(owed, now)))}
      onAmountChange={(jobId, text) =>
        change(() => {
          setTyped((now) => typeAmount(now, jobId, text));
          // An amount is typed for a video that is paid: it is ticked.
          setTicked((now) => (now.has(jobId) ? now : toggleTicked(now, jobId)));
        })
      }
      onPaidOnChange={(next) => change(() => setPaidOn(next))}
      onConfirm={() => void confirm()}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onCloseAutoFocus={(event) => {
        // There is no trigger element to give focus back to (the dialog is asked for from the
        // row's button or right-click menu); the row's own button gets it, or the row.
        event.preventDefault();
        rowFocusTarget(request.jobId)?.focus();
      }}
    />
  );
}
