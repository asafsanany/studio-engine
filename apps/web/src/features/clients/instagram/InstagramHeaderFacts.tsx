import { ExternalLink } from 'lucide-react';
import type { HeaderFacts } from './head-view';

/**
 * What the client page's header says first, for a client with an Instagram account (board CLPage):
 * the handle as a link to the account, then the followers, each followed by the middle dot that
 * leads into "6 jobs · last job 2 d ago". Rendered inside the header's muted line.
 */
export function InstagramHeaderFacts({ facts }: { facts: HeaderFacts }) {
  return (
    <>
      <a
        href={facts.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`@${facts.handle} on Instagram`}
        className="inline-flex items-center gap-1 align-baseline text-foreground underline-offset-4 hover:underline"
      >
        @{facts.handle}
        <ExternalLink aria-hidden="true" className="size-[13px] text-muted-foreground" />
      </a>
      {' · '}
      {facts.followers !== null && `${facts.followers} · `}
    </>
  );
}
