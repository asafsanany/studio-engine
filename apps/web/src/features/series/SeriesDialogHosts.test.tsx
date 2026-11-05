import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';
import { SeriesDialogHosts } from './SeriesDialogHosts';

describe('<SeriesDialogHosts>', () => {
  it('draws nothing until a row asks for one of the two dialogs', () => {
    expect(
      renderToStaticMarkup(
        <QueryClientProvider client={createTestQueryClient()}>
          <SeriesDialogHosts />
        </QueryClientProvider>,
      ),
    ).toBe('');
  });
});
