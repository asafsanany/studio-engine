/**
 * The player's place while the job runs and there is no cut to play yet (Draft & chat): black, as
 * big as the player would be, with one line on what goes on (`stageWaiting`), or nothing while that
 * is not known yet. Once there is a cut the player plays it here instead; Claude's pictures stay in
 * the chat (the owner, 29 Oct: the preview shows the preview).
 */
export function ChatStage({
  width,
  height,
  waiting,
}: {
  width: number | string;
  height: number | string;
  waiting: string | null;
}) {
  return (
    <div
      data-slot="chat-stage"
      className="flex shrink-0 flex-col bg-black"
      style={{ width, height }}
    >
      {waiting !== null && (
        <p className="m-auto px-6 text-center text-muted-foreground">{waiting}</p>
      )}
    </div>
  );
}
