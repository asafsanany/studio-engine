import { isValidElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AddInstagramLink } from './AddInstagramLink';
import { instagramDialogStore } from './instagram/instagram-dialog';

// "Add Instagram" at the end of a Clients row opens the Instagram… dialog (IG11) for that client.

afterEach(() => instagramDialogStore.getState().dismiss());

describe('<AddInstagramLink>', () => {
  it('asks for the Instagram dialog of its client when clicked', () => {
    const element = AddInstagramLink({
      client: { clientId: 'a00000000004', name: 'Noa Ceramics' },
    });
    if (!isValidElement<{ onClick: () => void; type: string }>(element)) {
      throw new Error('the link did not render an element');
    }
    expect(instagramDialogStore.getState().clientId).toBeNull();

    element.props.onClick();

    expect(instagramDialogStore.getState().clientId).toBe('a00000000004');
  });

  it('opens the dialog for the client of its own row, not the last one asked for', () => {
    for (const clientId of ['a00000000004', 'a00000000005']) {
      const element = AddInstagramLink({ client: { clientId, name: 'Someone' } });
      if (!isValidElement<{ onClick: () => void }>(element)) throw new Error('no element');
      element.props.onClick();
      expect(instagramDialogStore.getState().clientId).toBe(clientId);
    }
  });

  it('says Edit account for a private account, and still opens its dialog', () => {
    const element = AddInstagramLink({
      client: { clientId: 'a00000000003', name: 'Quiet Studio' },
      hasAccount: true,
    });
    if (!isValidElement<{ onClick: () => void; children: string; 'aria-label': string }>(element)) {
      throw new Error('no element');
    }
    expect(element.props.children).toBe('Edit account');
    expect(element.props['aria-label']).toBe('Edit account for Quiet Studio');
    element.props.onClick();
    expect(instagramDialogStore.getState().clientId).toBe('a00000000003');
  });
});
