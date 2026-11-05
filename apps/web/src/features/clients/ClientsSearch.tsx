import { Search } from 'lucide-react';
import { useId } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { Input } from '@/components/ui/input';
import { type ClientsUiStore, clientsUiStore } from '@/stores/clients-ui';

/**
 * The search box above the Clients table: 256 px, a magnifier inside, `type="search"` (so the
 * browser adds its clear button). Like the Jobs search it writes every keystroke straight to the
 * store, which keeps Hebrew and other IME composition intact.
 */
export function ClientsSearch({ store = clientsUiStore }: { store?: StoreApi<ClientsUiStore> }) {
  const id = useId();
  const search = useStore(store, (state) => state.search);
  const setSearch = useStore(store, (state) => state.setSearch);

  return (
    <div className="relative w-64 max-w-full">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
      />
      <label htmlFor={id} className="sr-only">
        Search clients
      </label>
      <Input
        id={id}
        type="search"
        placeholder="Search clients"
        autoComplete="off"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="pl-8.5 shadow-xs"
      />
    </div>
  );
}
