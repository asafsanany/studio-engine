import { type ClientRow, normalizeInstagramHandle } from '@studio/shared';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCreateClient, useInstagramEnabled, useSetClientInstagram } from '@/data';
import {
  NEW_CLIENT_TEXT,
  newClientErrorText,
  newClientInstagramFailure,
  newClientNameProblem,
} from './new-client';

/**
 * The dialog's form: a Name field (`dir="auto"`, so a Hebrew name reads right to left) with
 * Cancel and Create. Enter in the field creates. A name the rules refuse, or that the server
 * refuses (400 with its reason, 409 when taken), is said under the field; typing again clears it.
 * Once created, the new client's Style page opens: shaping its style is what a new client is for.
 *
 * While Clients × Instagram is on there is an optional Instagram field (a name or a link): it is
 * checked before the client is made, saved once it is (the first scan starts), and a refusal after
 * that is said under the field with a Continue button, since the client exists by then.
 *
 * It lives inside the dialog's content, so closing the dialog drops what was typed.
 */
export function NewClientForm({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  const create = useCreateClient();
  const instagramOn = useInstagramEnabled();
  const saveInstagram = useSetClientInstagram();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [instagram, setInstagram] = useState('');
  const [instagramProblem, setInstagramProblem] = useState<string | null>(null);
  // The client exists but its Instagram was not saved: the form waits to go on to the new client.
  const [made, setMade] = useState<ClientRow | null>(null);
  const fieldId = useId();
  const problemId = `${fieldId}-problem`;
  const instagramId = `${fieldId}-instagram`;
  const instagramNote = `${instagramId}-note`;
  const shown = problem ?? (create.isError ? newClientErrorText(create.error) : null);
  const instagramShown =
    instagramProblem ?? (made !== null ? newClientInstagramFailure(saveInstagram.error) : null);
  const busy = create.isPending || saveInstagram.isPending;

  function finish(client: ClientRow) {
    onCreated();
    void navigate({ to: '/clients/$clientId/style', params: { clientId: client.clientId } });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (made !== null) return finish(made);
    if (busy) return;
    const refused = newClientNameProblem(name);
    setProblem(refused);
    // The Instagram account is checked before the client is made, so a wrong one does not leave a client behind.
    const typed = instagramOn ? instagram.trim() : '';
    const parsed = typed === '' ? null : normalizeInstagramHandle(typed);
    const instagramRefused = parsed !== null && !parsed.ok ? parsed.error : null;
    setInstagramProblem(instagramRefused);
    if (refused !== null || instagramRefused !== null) return;
    const handle = parsed?.ok ? parsed.handle : null;
    create.mutate(name, {
      onSuccess: async (client) => {
        if (handle === null) return finish(client);
        try {
          await saveInstagram.mutateAsync({
            clientId: client.clientId,
            account: { handle, since: null },
          });
          finish(client);
        } catch {
          setMade(client);
        }
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{NEW_CLIENT_TEXT.title}</DialogTitle>
        <DialogDescription>{NEW_CLIENT_TEXT.description}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <label htmlFor={fieldId} className="text-sm leading-none font-medium">
          {NEW_CLIENT_TEXT.nameLabel}
        </label>
        <Input
          id={fieldId}
          dir="auto"
          autoComplete="off"
          value={name}
          disabled={made !== null}
          aria-invalid={shown !== null || undefined}
          aria-describedby={shown !== null ? problemId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
            create.reset();
          }}
        />
        {shown !== null && (
          <p id={problemId} role="alert" className="text-sm text-destructive">
            {shown}
          </p>
        )}
      </div>

      {instagramOn && (
        <div className="flex flex-col gap-2">
          <label htmlFor={instagramId} className="text-sm leading-none font-medium">
            {NEW_CLIENT_TEXT.instagramLabel}
          </label>
          <Input
            id={instagramId}
            dir="ltr"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={NEW_CLIENT_TEXT.instagramPlaceholder}
            value={instagram}
            disabled={made !== null}
            aria-invalid={instagramShown !== null || undefined}
            aria-describedby={instagramNote}
            onChange={(event) => {
              setInstagram(event.target.value);
              setInstagramProblem(null);
            }}
          />
          {instagramShown === null ? (
            <p id={instagramNote} className="text-xs text-muted-foreground">
              {NEW_CLIENT_TEXT.instagramHint}
            </p>
          ) : (
            <p id={instagramNote} role="alert" className="text-sm text-destructive">
              {instagramShown}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {NEW_CLIENT_TEXT.cancel}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={busy}>
          {busy
            ? NEW_CLIENT_TEXT.creating
            : made !== null
              ? NEW_CLIENT_TEXT.continue
              : NEW_CLIENT_TEXT.create}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The "New client" button, an outline button with a plus at the right of the Clients toolbar, and
 * the dialog it opens.
 */
export function NewClientDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus aria-hidden="true" />
          {NEW_CLIENT_TEXT.open}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        <NewClientForm onCreated={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
