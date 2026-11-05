import type { ClientSummary } from './clients';
import { askToEditInstagram } from './instagram/instagram-dialog';

/**
 * "Add Instagram" at the end of a Clients row that has no readable account (board CLList, L1), or
 * "Edit account" when the account is there and private (the client page's private line says the
 * same). It asks for the Instagram… dialog (IG11) for the client; the page (`ClientsPage`) shows the
 * dialog, as it does for the row menu's Instagram… item. It looks like a link and is a button,
 * since it opens a dialog and goes nowhere.
 *
 * It sits above the row's stretched name link (`z-10`, as the name's tooltip does), so a click on
 * it is its own and not the row's.
 */
export function AddInstagramLink({
  client,
  hasAccount = false,
}: {
  client: Pick<ClientSummary, 'clientId' | 'name'>;
  /** The client has an account the scan can't read (private): the dialog edits it. */
  hasAccount?: boolean;
}) {
  const label = hasAccount ? 'Edit account' : 'Add Instagram';
  return (
    <button
      type="button"
      onClick={() => askToEditInstagram(client.clientId)}
      aria-label={`${label} for ${client.name}`}
      data-slot="add-instagram"
      className="relative z-10 cursor-pointer rounded-xs text-blue-300 outline-none hover:text-blue-200 focus-visible:text-blue-200 focus-visible:underline"
    >
      {label}
    </button>
  );
}
