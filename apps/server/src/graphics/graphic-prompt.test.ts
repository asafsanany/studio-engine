import { existsSync } from 'node:fs';
import type { GraphicMessage } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  buildGraphicPrompt,
  foldFontNames,
  formatAsked,
  formatConversation,
  formatGraphicFonts,
  formatGraphicRefs,
  GRAPHIC_CHECK_SCRIPT,
  type GraphicPromptVars,
  quote,
} from './graphic-prompt.js';

const ID = 'a1b2c3d4e5f6';

function vars(overrides: Partial<GraphicPromptVars> = {}): GraphicPromptVars {
  return {
    id: ID,
    version: 1,
    first: true,
    asked: 'A lower third: the person’s name on a white pill and their role under it.',
    conversation: [],
    refs: [],
    fonts: ['Hebrew + English/Heebo/Heebo-Bold.ttf', 'Hebrew + English/Heebo/Heebo-Regular.ttf'],
    ...overrides,
  };
}

function message(overrides: Partial<GraphicMessage>): GraphicMessage {
  return {
    id: 'm',
    role: 'you',
    text: '',
    refs: [],
    effort: null,
    version: null,
    status: null,
    step: null,
    error: null,
    startedAt: null,
    endedAt: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildGraphicPrompt', () => {
  it('makes v1 from graphic-make.md with the rules, the request and the check', async () => {
    const prompt = await buildGraphicPrompt(
      vars({ refs: ['logo.png'], asked: 'A lower third\nwith a {{name}} in it' }),
    );
    expect(prompt).toMatch(/^Make a new graphic for the owner's graphics library: version 1\./);
    expect(prompt).toContain('> A lower third\n> with a {{name}} in it');
    expect(prompt).toContain('- ../refs/logo.png');
    expect(prompt).toContain(`compositions/lib-${ID}.html`);
    expect(prompt).toContain(`<div id="root" data-composition-id="lib-${ID}">`);
    expect(prompt).toContain(`window.__timelines["lib-${ID}"]`);
    expect(prompt).toContain(`node "${GRAPHIC_CHECK_SCRIPT}" ${ID} <length>`);
    expect(prompt).toContain('- ../fonts/Hebrew + English/Heebo/: Heebo-{Bold,Regular}.ttf');
    expect(prompt).toContain('`name`: what the graphic is called in the library');
    expect(prompt).toContain('Start with "Made v1."');
    expect(prompt).toContain('This run is unattended');
    expect(prompt).toContain('You are done when about.json exists and the check passes.');
    expect(prompt.trimEnd().split('\n').at(-1)).toMatch(/^You are done when .*Blocked:/);
    // Nothing of the template is left unfilled; only the owner's own braces stay.
    expect(prompt.replace('{{name}}', '')).not.toMatch(/\{\{/);
    expect(prompt.endsWith('\n')).toBe(true);
  });

  it('makes a later version from graphic-change.md with the chat so far', async () => {
    const prompt = await buildGraphicPrompt(
      vars({
        version: 3,
        first: false,
        asked: 'slower and higher',
        conversation: [
          message({ role: 'you', text: 'A big number that counts up', refs: ['ref.mp4'] }),
          message({ role: 'claude', text: 'Made v1. It counts up.', version: 1, status: 'done' }),
          message({ role: 'you', text: 'make it dark' }),
          message({
            role: 'claude',
            version: 2,
            status: 'failed',
            error: 'It took longer than 20 minutes.',
          }),
        ],
      }),
    );
    expect(prompt).toMatch(/^Change a graphic in the owner's graphics library: make version 3\./);
    expect(prompt).toContain(
      'The owner:\n> A big number that counts up\nAttached: ../refs/ref.mp4\n\nClaude v1:\n> Made v1. It counts up.',
    );
    expect(prompt).toContain('Claude, making v2 (failed):\n> It took longer than 20 minutes.');
    expect(prompt).toContain('Their new message:\n> slower and higher');
    expect(prompt).toContain('Files they attached to it:\nNone.');
    expect(prompt).toContain('Leave `name` out: the graphic keeps the name it has.');
    expect(prompt).toContain('Start with "Made v3."');
    expect(prompt).not.toMatch(/\{\{/);
  });

  it('ships the check script it names', () => {
    expect(GRAPHIC_CHECK_SCRIPT).toMatch(/assets\/graphics\/check-graphic\.mjs$/);
    expect(existsSync(GRAPHIC_CHECK_SCRIPT)).toBe(true);
  });
});

describe('the variables', () => {
  it('quotes every line of a message, and says when a message is only files', () => {
    expect(quote('one\r\n\ntwo  ')).toBe('> one\n>\n> two');
    expect(formatAsked('  ')).toBe('(No words: only the attached files.)');
    expect(formatAsked('make it dark')).toBe('> make it dark');
  });

  it('lists the attached files as ../refs/ paths on one line each', () => {
    expect(formatGraphicRefs([])).toBe('None.');
    expect(formatGraphicRefs(['a.png', 'b\nc.mp4'])).toBe('- ../refs/a.png\n- ../refs/b c.mp4');
  });

  it('names how each of Claude’s rows ended', () => {
    const text = formatConversation([
      message({ role: 'claude', version: 2, status: 'stopped', text: '' }),
      message({ role: 'claude', version: 3, status: 'done', text: 'v1 is back, as v3.' }),
    ]);
    expect(text).toBe(
      'Claude, making v2 (stopped by the owner):\n\nClaude v3:\n> v1 is back, as v3.',
    );
    expect(formatConversation([])).toBe('(Nothing yet.)');
  });

  it('lists the fonts one folder to a line, folded', () => {
    expect(
      formatGraphicFonts([
        'Hebrew + English/Rubik/Rubik-Bold.ttf',
        'English only/Inter/Inter-Regular.ttf',
        'Hebrew + English/Rubik/Rubik-Black.ttf',
        'loose.otf',
      ]),
    ).toBe(
      [
        '- ../fonts/: loose.otf',
        '- ../fonts/English only/Inter/: Inter-Regular.ttf',
        '- ../fonts/Hebrew + English/Rubik/: Rubik-{Black,Bold}.ttf',
      ].join('\n'),
    );
    expect(formatGraphicFonts([])).toMatch(/^There are no shared fonts/);
  });

  it('folds only names that share a start and an extension', () => {
    expect(foldFontNames(['Heebo-Black.ttf', 'Heebo-Bold.ttf'])).toBe('Heebo-{Black,Bold}.ttf');
    expect(foldFontNames(['AmaticSC-Bold.ttf', 'AmaticSC-Regular.ttf'])).toBe(
      'AmaticSC-{Bold,Regular}.ttf',
    );
    expect(foldFontNames(['A-Bold.ttf', 'A-Bold.otf'])).toBe('A-Bold.ttf, A-Bold.otf');
    expect(foldFontNames(['Inter.ttf', 'InterItalic.ttf'])).toBe('Inter.ttf, InterItalic.ttf');
    expect(foldFontNames(['One.ttf'])).toBe('One.ttf');
  });
});
