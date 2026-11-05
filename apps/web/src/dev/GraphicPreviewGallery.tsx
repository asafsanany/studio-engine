// Dev-only section of the /components gallery (CVP-267): the Graphics preview column, live on a
// canned lower third. See ComponentsPage.tsx, which mounts it. The graphic and the host page are
// served by apps/web/dev-graphic-sample.ts, which answers the engine's addresses
// (/api/graphics/<id>/v/<n>/host.html…) at /__dev/graphic-sample/ with no engine behind it.

import type { GraphicVars } from '@studio/shared';
import { type ReactNode, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GraphicPreview, type PreviewGraphic } from '@/features/graphics/studio/GraphicPreview';
import { cn } from '@/lib/utils';

// The canned graphic's id and where it is mounted (apps/web/dev-graphic-sample.ts; a node-side file
// the browser can't import).
const SAMPLE_BASE = '/__dev/graphic-sample';
const SAMPLE_ID = '5a3e1c0de001';
const SAMPLE_LENGTH_SEC = 3;
/** The canned graphic's own text, which a field that is left empty falls back to. */
const DEFAULTS = { name: 'דנה לוי', role: 'מייסדת, Kova Coffee' };

function Section({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-3.5 rounded-[10px] border p-6', className)}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="font-mono text-xs text-muted-foreground">{note}</div>
      </div>
      {children}
    </section>
  );
}

function sampleGraphic(
  overrides: Pick<PreviewGraphic, 'version' | 'makingVersion'> = {
    version: 3,
    makingVersion: null,
  },
): PreviewGraphic {
  return { id: SAMPLE_ID, lengthSec: SAMPLE_LENGTH_SEC, ...overrides };
}

type Version = 1 | 2 | 3;
const VERSIONS: readonly Version[] = [1, 2, 3];

function LivePreview() {
  const [name, setName] = useState(DEFAULTS.name);
  const [role, setRole] = useState(DEFAULTS.role);
  const [shown, setShown] = useState<Version>(3);
  const [making, setMaking] = useState<'off' | 'on'>('off');
  const [lastAction, setLastAction] = useState('—');

  const values: GraphicVars = { name, role };
  return (
    <Section
      title="Live · lower third, looping"
      note="GraphicPreview · /__dev/graphic-sample/<id>/v/<n>/host.html · text re-keys 300 ms after the last keystroke"
      className="lg:col-span-2"
    >
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex h-[640px] min-w-0 overflow-hidden rounded-lg border">
          <GraphicPreview
            graphic={sampleGraphic()}
            shownVersion={shown}
            newestVersion={3}
            values={values}
            making={making === 'on' ? 4 : null}
            apiBase={SAMPLE_BASE}
            onBackToNewest={() => {
              setShown(3);
              setLastAction('Back to v3');
            }}
            onUseOld={() => {
              setLastAction(`Use v${shown} again`);
            }}
          />
        </div>
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5 text-muted-foreground">
            <label htmlFor="gr3-name">Name</label>
            <Input
              id="gr3-name"
              dir="auto"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5 text-muted-foreground">
            <label htmlFor="gr3-role">Role</label>
            <Input
              id="gr3-role"
              dir="auto"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5 text-muted-foreground">
            Version on show
            <Tabs
              value={String(shown)}
              onValueChange={(value) => setShown(Number(value) as Version)}
            >
              <TabsList aria-label="Version on show">
                {VERSIONS.map((version) => (
                  <TabsTrigger key={version} value={String(version)}>
                    {`v${version}`}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <div className="flex flex-col gap-1.5 text-muted-foreground">
            A version is being made
            <Tabs value={making} onValueChange={(value) => setMaking(value as 'off' | 'on')}>
              <TabsList aria-label="Making v4">
                <TabsTrigger value="off">No</TabsTrigger>
                <TabsTrigger value="on">Making v4</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            last button pressed: {lastAction}
          </div>
        </div>
      </div>
    </Section>
  );
}

function EmptyStates() {
  return (
    <>
      <Section title="No version yet" note="graphic.version null · nothing being made">
        <div className="flex h-[420px] overflow-hidden rounded-lg border">
          <GraphicPreview
            graphic={sampleGraphic({ version: null, makingVersion: null })}
            apiBase={SAMPLE_BASE}
          />
        </div>
      </Section>
      <Section title="Making v1" note="graphic.version null · makingVersion 1">
        <div className="flex h-[420px] overflow-hidden rounded-lg border">
          <GraphicPreview
            graphic={sampleGraphic({ version: null, makingVersion: 1 })}
            apiBase={SAMPLE_BASE}
            initialSize="16x9"
          />
        </div>
      </Section>
    </>
  );
}

export function GraphicPreviewGallery() {
  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-[-0.01em]">GR3 · Graphics preview</h2>
        <p className="mt-1 text-muted-foreground">
          The studio’s middle column on a canned lower third (3 s, plus a 0.8 s tail that lets the
          loop breathe). Switch Size and Behind it, type in Name or Role (the picture changes after
          a pause and keeps its place), pick an older version for “Showing v1. Edits use v3.”, or
          turn on Making v4 for the chip.
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <LivePreview />
        <EmptyStates />
      </div>
    </>
  );
}
