import { describe, expect, it } from 'vitest';
import { ActionError } from './ActionError';
import { renderCell } from './test-helpers';

const wrapped = (message: string | null) =>
  renderCell(
    <ActionError message={message} onDismiss={() => {}}>
      <div id="buttons">buttons</div>
    </ActionError>,
  );

describe('<ActionError>', () => {
  it('wraps the buttons without changing them', () => {
    expect(wrapped(null)).toMatch(/<div id="buttons"[^>]*>buttons<\/div>/);
  });

  it('is closed when there is no error', () => {
    expect(wrapped(null)).toContain('data-state="closed"');
  });

  it('is open while there is an error to show', () => {
    expect(wrapped('Only an editing job can be cancelled.')).toMatch(
      /data-state="(instant|delayed)-open"/,
    );
  });
});
