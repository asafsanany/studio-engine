import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { AssignToForm } from '@/features/clients/assign/AssignToForm';
import { ASSIGN_TEXT } from '@/features/clients/assign/assign-text';
import { cn } from '@/lib/utils';
import { PHONE_SHEET_CLASSES } from './phone-sheet-shell';

/**
 * "Assign to…" on the phone (the admin's, from the client's page): a bottom sheet with a 48 px
 * checkbox row per editor and a full-width Save. The grabber, a tap on the dimmed page and Esc
 * close it. `client` is `null` while the sheet is closed.
 */
export function PhoneAssignSheet({
  client,
  onClose,
}: {
  client: { clientId: string; name: string } | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={client !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        data-slot="phone-assign-sheet"
        className={cn(PHONE_SHEET_CLASSES, '[-webkit-tap-highlight-color:transparent]')}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <SheetGrabber onClose={onClose} className="pt-2" />
        <div className="flex flex-col gap-1 px-4 pt-3.5 pb-3">
          <SheetTitle className="text-lg leading-[1.3]">
            {ASSIGN_TEXT.title} <bdi>{client?.name ?? ''}</bdi>
          </SheetTitle>
          <SheetDescription className="text-sm">{ASSIGN_TEXT.question}</SheetDescription>
        </div>
        <div className="px-2">
          {client !== null && (
            <AssignToForm
              key={client.clientId}
              client={client}
              onDone={onClose}
              phone
              footer={({ saving, canSave }) => (
                <div className="px-2 pt-1">
                  <Button
                    type="submit"
                    disabled={saving || !canSave}
                    aria-busy={saving}
                    className="h-12 w-full text-[15px]"
                  >
                    {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
                    {saving ? ASSIGN_TEXT.saving : ASSIGN_TEXT.save}
                  </Button>
                </div>
              )}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
