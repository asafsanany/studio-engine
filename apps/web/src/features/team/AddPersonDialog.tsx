import type { TeamRole } from '@studio/shared';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAddTeamUser } from '@/data';
import { addPersonProblem, ROLE_CHOICES, TEAM_TEXT, teamErrorText } from './team-text';

/**
 * The dialog's form: Name, Login and Role (Editor or Admin), with Cancel and Add. Enter adds. A
 * missing name or login is said under the fields at once; the server's refusals (the login is on
 * the team already, it is the owner's) come back in the same place. Typing again clears it. It
 * lives inside the dialog's content, so closing the dialog drops what was typed.
 */
export function AddPersonForm({ onAdded }: { onAdded: () => void }) {
  const add = useAddTeamUser();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('editor');
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const problemId = `${id}-problem`;
  const shown = problem ?? (add.isError ? teamErrorText(add.error) : null);

  function edit(change: () => void) {
    change();
    setProblem(null);
    add.reset();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (add.isPending) return;
    const refused = addPersonProblem(name, email);
    setProblem(refused);
    if (refused !== null) return;
    add.mutate({ name: name.trim(), email: email.trim(), role }, { onSuccess: onAdded });
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{TEAM_TEXT.addTitle}</DialogTitle>
        <DialogDescription>{TEAM_TEXT.addDescription}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-name`} className="text-sm leading-none font-medium">
          {TEAM_TEXT.nameLabel}
        </label>
        <Input
          id={`${id}-name`}
          dir="auto"
          autoComplete="off"
          value={name}
          aria-invalid={shown !== null || undefined}
          aria-describedby={shown !== null ? problemId : undefined}
          onChange={(event) => edit(() => setName(event.target.value))}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-email`} className="text-sm leading-none font-medium">
          {TEAM_TEXT.emailLabel}
        </label>
        <Input
          id={`${id}-email`}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={TEAM_TEXT.emailPlaceholder}
          value={email}
          aria-invalid={shown !== null || undefined}
          aria-describedby={shown !== null ? problemId : undefined}
          onChange={(event) => edit(() => setEmail(event.target.value))}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm leading-none font-medium">{TEAM_TEXT.roleLabel}</legend>
        <RadioGroup
          value={role}
          onValueChange={(next) => edit(() => setRole(next === 'admin' ? 'admin' : 'editor'))}
          aria-label={TEAM_TEXT.roleLabel}
        >
          {ROLE_CHOICES.map((choice) => (
            <label
              key={choice.role}
              htmlFor={`${id}-${choice.role}`}
              className="flex cursor-pointer items-start gap-2.5"
            >
              <RadioGroupItem id={`${id}-${choice.role}`} value={choice.role} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm leading-none font-medium">{choice.label}</span>
                <span className="text-sm text-muted-foreground">{choice.hint}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      {shown !== null && (
        <p id={problemId} role="alert" className="text-sm text-destructive">
          {shown}
        </p>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {TEAM_TEXT.cancel}
          </Button>
        </DialogClose>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? TEAM_TEXT.creating : TEAM_TEXT.create}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The "Add person" button of the Team page and the dialog it opens. */
export function AddPersonDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus aria-hidden="true" />
          {TEAM_TEXT.add}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        <AddPersonForm onAdded={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
