import { CalendarDays, Loader2 } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  useClientInstagram,
  useClients,
  useDeleteClientInstagram,
  useJobs,
  useSetClientInstagram,
} from '@/data';
import { cn } from '@/lib/utils';
import { todayLocal } from '../../jobs/mark-paid/pay-list';
import {
  confirmRemoveInstagram,
  confirmSaveInstagram,
  INSTAGRAM_DIALOG_TEXT,
  type InstagramDialogState,
  instagramDialogStore,
  instagramDialogTitle,
  removeDescription,
  sinceHint,
  useInstagramDialog,
} from './instagram-dialog';
import { firstDeliveryDay } from './instagram-first-delivery';
import { readSinceText, sinceDayText } from './instagram-since';
import type { TextOptions } from './instagram-text';

const HINT_CLASS = 'text-xs text-muted-foreground';

/** What the dialog's content draws: the fields as typed, what is said about them, and what the buttons do. */
export interface InstagramDialogContentProps {
  clientName: string;
  /** The client has an account: the dialog edits it and offers Remove Instagram. */
  hasAccount: boolean;
  /** The account is still being read: the fields wait for it. */
  loading: boolean;
  /** The saved account's handle, which Remove Instagram names. */
  accountHandle: string;
  handle: string;
  since: string;
  handleProblem: string | null;
  sinceProblem: string | null;
  /** The first delivery's day (YYYY-MM-DD) for the line under the date; `null` for a client with none. */
  firstDelivery: string | null;
  /** Today's day: the latest the work can have started. */
  today: string;
  step: 'edit' | 'remove';
  pending: boolean;
  error: string | null;
  onHandleChange: (handle: string) => void;
  onHandleBlur: () => void;
  onSinceChange: (since: string) => void;
  onSinceBlur: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onAskRemove: () => void;
  onKeep: () => void;
  onRemove: () => void;
  textOptions?: TextOptions;
  /** Where the cursor starts (the handle field). The tests leave it out. */
  handleRef?: React.Ref<HTMLInputElement>;
}

/**
 * What is inside the dialog (board S1): "Instagram · Falcon FPV" with what a scan costs, the account
 * (a name or a link) and the day the work together started, and Cancel and Save and scan. A client
 * that has an account also has Remove Instagram at the left, which turns the dialog into its
 * question (Cancel or Remove Instagram: it keeps what was read). A form, so Enter saves.
 */
export function InstagramDialogContent(props: InstagramDialogContentProps) {
  const { step, clientName, accountHandle, pending, error } = props;
  const errorId = useId();
  const problem = error === null ? null : <ErrorLine id={errorId}>{error}</ErrorLine>;

  if (step === 'remove') {
    return (
      <div className="grid gap-5">
        <DialogHeader>
          <DialogTitle className="leading-[1.43]">{INSTAGRAM_DIALOG_TEXT.removeTitle}</DialogTitle>
          <DialogDescription>{removeDescription(accountHandle, clientName)}</DialogDescription>
        </DialogHeader>
        {problem}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={pending} onClick={props.onKeep}>
            {INSTAGRAM_DIALOG_TEXT.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            aria-busy={pending}
            onClick={props.onRemove}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? INSTAGRAM_DIALOG_TEXT.removing : INSTAGRAM_DIALOG_TEXT.remove}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return <InstagramForm {...props} errorLine={problem} />;
}

function ErrorLine({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="text-[13px] text-pretty text-destructive">
      {children}
    </p>
  );
}

function InstagramForm({
  clientName,
  hasAccount,
  loading,
  handle,
  since,
  handleProblem,
  sinceProblem,
  firstDelivery,
  today,
  pending,
  errorLine,
  onHandleChange,
  onHandleBlur,
  onSinceChange,
  onSinceBlur,
  onSubmit,
  onCancel,
  onAskRemove,
  textOptions,
  handleRef,
}: InstagramDialogContentProps & { errorLine: React.ReactNode }) {
  const handleId = useId();
  const sinceId = useId();
  const handleNote = `${handleId}-note`;
  const sinceNote = `${sinceId}-note`;
  const locked = pending || loading;
  const picker = useRef<HTMLInputElement>(null);
  // The calendar opens on what is typed, when that is a day.
  const reading = readSinceText(since);
  const pickedDay = reading.kind === 'day' ? reading.day : '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={loading || undefined} className="grid gap-5">
      <DialogHeader>
        <DialogTitle className="leading-[1.43]">{instagramDialogTitle(clientName)}</DialogTitle>
        <DialogDescription>{INSTAGRAM_DIALOG_TEXT.description}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={handleId} className="text-sm leading-none font-medium">
          {INSTAGRAM_DIALOG_TEXT.handleLabel}
        </label>
        <Input
          ref={handleRef}
          id={handleId}
          type="text"
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={INSTAGRAM_DIALOG_TEXT.handlePlaceholder}
          value={handle}
          disabled={locked}
          aria-invalid={handleProblem !== null || undefined}
          aria-describedby={handleNote}
          onChange={(event) => onHandleChange(event.target.value)}
          onBlur={onHandleBlur}
        />
        {handleProblem === null ? (
          <p id={handleNote} className={HINT_CLASS}>
            {INSTAGRAM_DIALOG_TEXT.handleHint}
          </p>
        ) : (
          <p id={handleNote} role="alert" className="text-xs text-destructive">
            {handleProblem}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={sinceId} className="text-sm leading-none font-medium">
          {INSTAGRAM_DIALOG_TEXT.sinceLabel}
        </label>
        <div className="relative">
          <Input
            id={sinceId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={INSTAGRAM_DIALOG_TEXT.sincePlaceholder}
            value={since}
            disabled={locked}
            aria-invalid={sinceProblem !== null || undefined}
            aria-describedby={sinceNote}
            onChange={(event) => onSinceChange(event.target.value)}
            onBlur={onSinceBlur}
            className="pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={locked}
            aria-label={INSTAGRAM_DIALOG_TEXT.pickDay}
            onClick={() => picker.current?.showPicker?.()}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
          >
            <CalendarDays aria-hidden="true" />
          </Button>
          {/* The browser's own calendar, behind the button: it opens under the field and hands back a
              day, which the field writes in its words. Drawn for the dark page, as in Mark paid. */}
          <input
            ref={picker}
            type="date"
            tabIndex={-1}
            aria-hidden="true"
            value={pickedDay}
            max={today}
            disabled={locked}
            onChange={(event) => {
              if (event.target.value !== '') onSinceChange(sinceDayText(event.target.value));
            }}
            className="pointer-events-none absolute right-0 bottom-0 h-0 w-full opacity-0 [color-scheme:dark]"
          />
        </div>
        {sinceProblem === null ? (
          <p id={sinceNote} className={HINT_CLASS}>
            {sinceHint(firstDelivery, textOptions)}
          </p>
        ) : (
          <p id={sinceNote} role="alert" className="text-xs text-destructive">
            {sinceProblem}
          </p>
        )}
      </div>

      {errorLine}

      <DialogFooter className={cn(hasAccount && 'sm:justify-between')}>
        {hasAccount && (
          <Button
            type="button"
            variant="ghost"
            disabled={locked}
            onClick={onAskRemove}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15"
          >
            {INSTAGRAM_DIALOG_TEXT.remove}
          </Button>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            {INSTAGRAM_DIALOG_TEXT.cancel}
          </Button>
          <Button type="submit" disabled={locked || handle.trim() === ''} aria-busy={pending}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? INSTAGRAM_DIALOG_TEXT.saving : INSTAGRAM_DIALOG_TEXT.save}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

/** "Reading @falcon.fpv. The page fills in when it is done": the message of a saved account. */
export function savedMessage(handle: string): string {
  return `Saved @${handle}. Reading it now.`;
}

/** The message of a removed account. */
export function removedMessage(handle: string): string {
  return `Removed @${handle}`;
}

/**
 * Inside the open dialog: reads the client's account (the cache has it when the client page is
 * open) to start the fields from, the client's name and its first delivery, and wires the buttons
 * to the two requests. It is mounted only while the dialog is, so closing it drops what was typed.
 */
function InstagramDialogBody({
  clientId,
  store,
}: {
  clientId: string;
  store: StoreApi<InstagramDialogState>;
}) {
  const state = useInstagramDialog(store);
  const instagram = useClientInstagram(clientId);
  const { data: clients } = useClients();
  const { data: jobs } = useJobs();
  const set = useSetClientInstagram();
  const del = useDeleteClientInstagram();
  const handleInput = useRef<HTMLInputElement>(null);

  // The fields start from the account once the engine has told it (once per opening). An engine
  // that cannot answer leaves them empty: saving sends what is typed.
  const account = instagram.data?.account;
  const answered = instagram.data !== undefined || instagram.isError;
  useEffect(() => {
    if (!answered) return;
    store
      .getState()
      .hydrate(account == null ? null : { handle: account.handle, since: account.since });
  }, [answered, account, store]);

  // The cursor goes to the account once the fields are there.
  const ready = state.hydrated;
  useEffect(() => {
    if (ready) handleInput.current?.focus();
  }, [ready]);

  const clientName = clients?.find((row) => row.clientId === clientId)?.client ?? '';
  const today = todayLocal();

  const save = () =>
    void confirmSaveInstagram(
      {
        save: (id, body) => set.mutateAsync({ clientId: id, account: body }),
        onSaved: (_id, handle) => toast.success(savedMessage(handle)),
        today: () => todayLocal(),
      },
      store,
    );
  const remove = () =>
    void confirmRemoveInstagram(
      {
        remove: (id) => del.mutateAsync(id),
        onRemoved: (_id, handle) => toast.success(removedMessage(handle)),
      },
      store,
    );

  return (
    <InstagramDialogContent
      clientName={clientName}
      hasAccount={state.hasAccount}
      loading={!state.hydrated}
      accountHandle={state.accountHandle}
      handle={state.handle}
      since={state.since}
      handleProblem={state.handleProblem}
      sinceProblem={state.sinceProblem}
      firstDelivery={firstDeliveryDay(jobs, clientId)}
      today={today}
      step={state.step}
      pending={state.pending}
      error={state.error}
      onHandleChange={state.setHandle}
      onHandleBlur={state.checkHandle}
      onSinceChange={state.setSince}
      onSinceBlur={() => state.checkSince(today)}
      onSubmit={save}
      onCancel={() => store.getState().dismiss()}
      onAskRemove={state.askToRemove}
      onKeep={state.keep}
      onRemove={remove}
      handleRef={handleInput}
    />
  );
}

/**
 * The Instagram dialog for the Clients page and a client's page (S1). A menu item, the empty state
 * and a scan problem's Edit account only ask (`askToEditInstagram`); the dialog lives here, one
 * level above them. Save and scan waits for the engine (the first scan is queued by it) and closes
 * the dialog; the client page fills in as the scan ends. Mount it once per page, only while
 * Clients × Instagram is on.
 */
export function InstagramDialogHost({
  store = instagramDialogStore,
}: {
  store?: StoreApi<InstagramDialogState>;
}) {
  const { clientId, opening, pending } = useInstagramDialog(store);
  // The content stays on the last client while the dialog fades out (the store forgets it at once).
  const [shown, setShown] = useState(clientId);
  if (clientId !== null && clientId !== shown) setShown(clientId);
  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().dismiss(), [store]);

  return (
    <Dialog
      open={clientId !== null}
      onOpenChange={(open) => {
        if (!open && !pending) store.getState().dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[420px]"
        onOpenAutoFocus={(event) => {
          // The fields are still on their way: the body puts the cursor in the account when they arrive.
          event.preventDefault();
        }}
      >
        {shown !== null && <InstagramDialogBody key={opening} clientId={shown} store={store} />}
      </DialogContent>
    </Dialog>
  );
}
