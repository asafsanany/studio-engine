import { type JobFormat, jobFormatsOf } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { NoteCard } from '../NoteCard';
import { renderReview, tagWith } from '../test-helpers';
import { FormatSwitch } from './FormatSwitch';
import { NoteHint } from './NoteHint';

const FORMATS = jobFormatsOf(['1080x1920', '1080x1080']) as JobFormat[];

function render(value: JobFormat, variant?: 'mac' | 'phone'): string {
  return renderReview(
    <FormatSwitch formats={FORMATS} value={value} onChange={() => {}} variant={variant} />,
  );
}

describe('<FormatSwitch>', () => {
  it('is a group named Format with one button per format, the one on show pressed', () => {
    const html = render(FORMATS[1] as JobFormat);
    expect(tagWith(html, 'role="group"')).toContain('aria-label="Format"');
    const main = tagWith(html, 'data-format="9x16"');
    const square = tagWith(html, 'data-format="1x1"');
    expect(main).toContain('aria-pressed="false"');
    expect(main).toContain('type="button"');
    expect(square).toContain('aria-pressed="true"');
    expect(html).toContain('9:16');
    expect(html).toContain('1:1');
  });

  it('has a pointer cursor and the board’s pressed fill', () => {
    const html = render(FORMATS[0] as JobFormat);
    expect(tagWith(html, 'data-format="9x16"')).toContain('cursor-pointer');
    expect(tagWith(html, 'data-format="9x16"')).toContain('bg-zinc-700');
    expect(tagWith(html, 'data-format="1x1"')).not.toContain('bg-zinc-700');
  });

  it('draws a small frame of each format’s shape in front of the Mac’s label, and none on the phone', () => {
    const mac = render(FORMATS[0] as JobFormat);
    expect(mac).toContain('width:8px;height:13px');
    expect(mac).toContain('width:11px;height:11px');
    expect(render(FORMATS[0] as JobFormat, 'phone')).not.toContain('border-[1.5px]');
  });

  it('is made for a finger on the phone: 38 px buttons in a 3 px frame, 88 px wide at least', () => {
    const html = render(FORMATS[0] as JobFormat, 'phone');
    expect(tagWith(html, 'data-format="1x1"')).toContain('h-[38px]');
    expect(tagWith(html, 'data-format="1x1"')).toContain('min-w-[88px]');
    expect(tagWith(html, 'data-slot="format-switch"')).toContain('p-[3px]');
  });
});

describe('<NoteHint>', () => {
  it('says its line in the colour of its tone, with its icon', () => {
    const html = renderReview(
      <NoteHint hint={{ tone: 'amber', text: 'New take of clip B on Send · about $0.51' }} />,
    );
    expect(tagWith(html, 'data-slot="note-hint"')).toContain('text-amber-400');
    expect(html).toContain('New take of clip B on Send · about $0.51');
    expect(html).toContain('<svg');
  });

  it('is blue for the voice and grey for an edit', () => {
    expect(
      tagWith(
        renderReview(<NoteHint hint={{ tone: 'blue', text: 'Remakes voice line 2' }} />),
        'data-slot="note-hint"',
      ),
    ).toContain('text-blue-300');
    expect(
      tagWith(
        renderReview(<NoteHint hint={{ tone: 'muted', text: 'Edit change' }} />),
        'data-slot="note-hint"',
      ),
    ).toContain('text-muted-foreground');
  });
});

describe('<NoteCard> with a mark', () => {
  const card = (mark?: React.ComponentProps<typeof NoteCard>['mark']): string =>
    renderReview(
      <NoteCard
        note={makeReviewNote({ atSec: 32, text: 'End card: logo bigger.', format: '1x1' })}
        jobId="a1b2c3d4e5f6"
        client="Pinewood"
        seriesName={null}
        hovered={false}
        active={false}
        onHover={() => {}}
        onGo={() => {}}
        onDelete={() => {}}
        cardRef={() => {}}
        onPlayVoice={() => {}}
        mark={mark}
      />,
    );

  it('prints the format after the time and the hint under the words', () => {
    const html = card({
      formatLabel: '1:1',
      hint: { tone: 'muted', text: 'Edit change · 1:1 only' },
    });
    expect(tagWith(html, 'aria-label="Go to 0:32 on 1:1"')).toContain('type="button"');
    expect(html).toContain('0:32<span>1:1</span>');
    expect(html.indexOf('End card: logo bigger.')).toBeLessThan(
      html.indexOf('Edit change · 1:1 only'),
    );
  });

  it('is the card it always was without a mark', () => {
    const html = card();
    expect(html).toContain('aria-label="Go to 0:32"');
    expect(html).not.toContain('note-hint');
  });
});
