import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import * as shared from './index.ts';

describe('@studio/shared', () => {
  it('loads as a module and resolves zod for schemas', () => {
    expect(shared).toBeTypeOf('object');
    expect(z.string().safeParse('ok').success).toBe(true);
  });

  it('exports the whole domain from the package root', () => {
    expect(Object.keys(shared)).toEqual(
      expect.arrayContaining([
        'CHECK_STEP',
        'FIRST_STEP_BY_RUN_KIND',
        'JOB_ACTIONS',
        'JOB_ACTION_PATHS',
        'JOB_REVEAL_MESSAGES',
        'JOB_STATES',
        'MONEY_FILE_NAME',
        'NOTE_MAX_LENGTH',
        'REVIEW_NOTE_MAX_LENGTH',
        'VOICE_NOTE_MAX_BYTES',
        'VOICE_NOTE_MAX_SEC',
        'VOICE_NOTE_TYPES',
        'PREVIEW_MISSING_ERROR',
        'PREVIEW_STEP',
        'RENDER_STEP',
        'RUN_KINDS',
        'STATUS_GROUPS',
        'STEPS',
        'STEP_IDS',
        'STEP_LABELS',
        'STYLE_NOTES_FILE_NAME_MAX_BYTES',
        'addNoteRequestSchema',
        'apiErrorSchema',
        'chargesBetween',
        'canEditNote',
        'deleteNoteResponseSchema',
        'firstStepOf',
        'formatNoteTime',
        'groupOf',
        'healthResponseSchema',
        'helloEventSchema',
        'inputCountsSchema',
        'isoTimestampSchema',
        'jobActionPath',
        'jobActionResponseSchema',
        'jobActionSchema',
        'jobListResponseSchema',
        'jobOutputSchema',
        'jobPreviewSchema',
        'jobRemoveEventSchema',
        'jobSchema',
        'jobStateSchema',
        'jobStepRunSchema',
        'jobStepsResponseSchema',
        'jobUpsertEventSchema',
        'moneyFileSchema',
        'noteListResponseSchema',
        'noteRemoveEventSchema',
        'noteResponseSchema',
        'noteUpsertEventSchema',
        'normalizeNote',
        'patchNoteRequestSchema',
        'priceForClient',
        'renderRoundFile',
        'renderSeriesNotesFile',
        'renderStyleNotesFile',
        'revealJobResponseSchema',
        'reviewNoteSchema',
        'runKindSchema',
        'saveNoteRequestSchema',
        'saveNoteResponseSchema',
        'sentNotesResponseSchema',
        'serverEventSchema',
        'statusGroupSchema',
        'stepIdSchema',
        'styleNotesFileName',
        'subscriptionCharges',
        'toIls',
        'voiceNoteType',
      ]),
    );
  });

  it('has no runtime dependency beyond zod', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
  });
});
