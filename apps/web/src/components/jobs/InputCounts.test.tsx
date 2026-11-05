import { describe, expect, it } from 'vitest';
import { InputCounts, inputSlots } from './InputCounts';
import { render } from './test-helpers';

describe('inputSlots', () => {
  it('is always four slots in the order video, audio, image, doc', () => {
    const slots = inputSlots({ doc: 1, image: 5, audio: 1, video: 0 });
    expect(slots.map((slot) => slot.type)).toEqual(['video', 'audio', 'image', 'doc']);
    expect(slots.map((slot) => slot.count)).toEqual([0, 1, 5, 1]);
  });

  it('words each tooltip the way inputTooltip does, singular and plural', () => {
    const slots = inputSlots({ video: 14, audio: 1, image: 0, doc: 1 });
    expect(slots.map((slot) => slot.tooltip)).toEqual([
      '14 video clips',
      '1 audio file',
      '0 images',
      '1 document',
    ]);
  });

  it('marks only the zero counts as empty', () => {
    const slots = inputSlots({ video: 0, audio: 1, image: 5, doc: 0 });
    expect(slots.map((slot) => slot.empty)).toEqual([true, false, false, true]);
  });
});

describe('<InputCounts>', () => {
  const html = render(<InputCounts inputs={{ video: 14, audio: 0, image: 1, doc: 1 }} />);

  it('lays the slots out on a grid of four 40 px columns with a 4 px gap', () => {
    expect(html).toMatch(/^<div class="grid grid-cols-\[repeat\(4,40px\)\] gap-1 /);
    expect(html.match(/data-input="/g)).toHaveLength(4);
    expect([...html.matchAll(/data-input="(\w+)"/g)].map((match) => match[1])).toEqual([
      'video',
      'audio',
      'image',
      'doc',
    ]);
  });

  it('puts a 16 px muted icon, then the count, in each slot', () => {
    expect(html.match(/size-4 shrink-0 text-muted-foreground/g)).toHaveLength(4);
    expect(html).toContain('lucide-video');
    expect(html).toContain('lucide-mic');
    expect(html).toContain('lucide-image');
    expect(html).toContain('lucide-file-text');
    expect(html).toContain('<span aria-hidden="true">14</span>');
  });

  it('dims only the slot whose count is 0', () => {
    expect(html.match(/opacity-50/g)).toHaveLength(1);
    expect(html).toMatch(/data-input="audio" class="[^"]*opacity-50/);
    expect(html).not.toMatch(/data-input="video" class="[^"]*opacity-50/);
  });

  it('makes every slot focusable and gives screen readers the tooltip text instead of the bare number', () => {
    expect(html.match(/tabindex="0"/g)).toHaveLength(4);
    expect(html).toContain('<span class="sr-only">14 video clips</span>');
    expect(html).toContain('<span class="sr-only">0 audio files</span>');
  });
});
