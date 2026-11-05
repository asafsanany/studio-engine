import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { type ClientPhotoSources, photoKey } from '@/data/client-photos';
import {
  ClientAvatar,
  ClientPhotosContext,
  forgetFailedPhotos,
  markPhotoFailed,
} from './ClientAvatar';

// A client's avatar: the initials, and over them the Instagram picture while there is one.

const SRC = '/api/clients/a00000000001/photo?v=1761818700000';
const NEW_SRC = '/api/clients/a00000000001/photo?v=1762423500000';

const photos = (entries: Record<string, string>): ClientPhotoSources =>
  new Map(Object.entries(entries).map(([name, src]) => [photoKey(name), src]));

const render = (node: React.ReactNode, sources?: ClientPhotoSources) =>
  renderToStaticMarkup(
    sources === undefined ? (
      node
    ) : (
      <ClientPhotosContext.Provider value={sources}>{node}</ClientPhotosContext.Provider>
    ),
  );

afterEach(() => forgetFailedPhotos());

describe('<ClientAvatar>: the initials', () => {
  it('shows the initials, tinted with the client’s hue, with no picture and no provider', () => {
    const markup = render(<ClientAvatar client="Falcon FPV" />);
    expect(markup).toContain('>FF<');
    expect(markup).toContain('--client-hue');
    expect(markup).not.toContain('<img');
  });

  it('keeps them for a client that has no picture, whoever else has one', () => {
    const markup = render(<ClientAvatar client="Noa Ceramics" />, photos({ 'Falcon FPV': SRC }));
    expect(markup).toContain('>NC<');
    expect(markup).not.toContain('<img');
  });

  it('is a decoration, hidden from screen readers', () => {
    expect(render(<ClientAvatar client="Falcon FPV" />)).toContain('aria-hidden="true"');
  });
});

describe('<ClientAvatar>: the Instagram picture', () => {
  it('shows the picture of a client that has one, over the initials', () => {
    const markup = render(<ClientAvatar client="Falcon FPV" />, photos({ 'Falcon FPV': SRC }));
    const img = markup.match(/<img[^>]*>/)?.[0] ?? '';
    expect(img).toContain(`src="${SRC}"`);
    expect(img).toContain('alt=""');
    expect(img).toContain('data-slot="client-photo"');
    expect(img).toContain('absolute inset-0');
    expect(img).toContain('object-cover');
    // The initials stay underneath, so they are what shows until the picture has loaded.
    expect(markup).toContain('>FF<');
    expect(markup.indexOf('>FF<')).toBeLessThan(markup.indexOf('<img'));
  });

  it('is not draggable, as a picture in a table row should not be', () => {
    const markup = render(<ClientAvatar client="Falcon FPV" />, photos({ 'Falcon FPV': SRC }));
    expect(markup).toContain('draggable="false"');
  });

  it('finds the client by the name’s NFC spelling', () => {
    const composed = 'Café Noa';
    const decomposed = 'Café Noa';
    const markup = render(<ClientAvatar client={decomposed} />, photos({ [composed]: SRC }));
    expect(markup).toContain(`src="${SRC}"`);
  });

  it('shows it at every size, and in a size a page asks for', () => {
    const sources = photos({ 'Falcon FPV': SRC });
    for (const size of ['sm', 'default', 'lg'] as const) {
      expect(render(<ClientAvatar client="Falcon FPV" size={size} />, sources)).toContain('<img');
    }
    const big = render(<ClientAvatar client="Falcon FPV" className="size-12" />, sources);
    expect(big).toContain('size-12');
    expect(big).toContain('<img');
  });

  it('keeps the initials alone where a page asks for no photo, as the Clients list does for a private account', () => {
    const sources = photos({ 'Falcon FPV': SRC });
    const markup = render(<ClientAvatar client="Falcon FPV" photo={false} />, sources);
    expect(markup).toContain('>FF<');
    expect(markup).not.toContain('<img');
    // The other avatars of the same client are not touched.
    expect(render(<ClientAvatar client="Falcon FPV" photo />, sources)).toContain('<img');
    expect(render(<ClientAvatar client="Falcon FPV" />, sources)).toContain('<img');
  });

  it('shows a Hebrew name’s picture too', () => {
    const markup = render(<ClientAvatar client="מאפיית הצפון" />, photos({ 'מאפיית הצפון': SRC }));
    expect(markup).toContain(`src="${SRC}"`);
  });
});

describe('<ClientAvatar>: a picture that does not load', () => {
  it('goes back to the initials alone once the address failed', () => {
    const sources = photos({ 'Falcon FPV': SRC });
    expect(render(<ClientAvatar client="Falcon FPV" />, sources)).toContain('<img');

    markPhotoFailed(SRC);

    const markup = render(<ClientAvatar client="Falcon FPV" />, sources);
    expect(markup).not.toContain('<img');
    expect(markup).toContain('>FF<');
  });

  it('is shared by every avatar of that picture, and no other client’s', () => {
    const sources = photos({
      'Falcon FPV': SRC,
      'Valley Winery': '/api/clients/a00000000002/photo?v=1',
    });
    markPhotoFailed(SRC);
    expect(render(<ClientAvatar client="Falcon FPV" size="sm" />, sources)).not.toContain('<img');
    expect(render(<ClientAvatar client="Falcon FPV" size="lg" />, sources)).not.toContain('<img');
    expect(render(<ClientAvatar client="Valley Winery" />, sources)).toContain('<img');
  });

  it('tries again for a new picture, which has a new address', () => {
    markPhotoFailed(SRC);
    expect(
      render(<ClientAvatar client="Falcon FPV" />, photos({ 'Falcon FPV': SRC })),
    ).not.toContain('<img');
    const markup = render(<ClientAvatar client="Falcon FPV" />, photos({ 'Falcon FPV': NEW_SRC }));
    expect(markup).toContain(`src="${NEW_SRC}"`);
  });

  it('forgets what failed when told to (a fresh start)', () => {
    markPhotoFailed(SRC);
    forgetFailedPhotos();
    expect(render(<ClientAvatar client="Falcon FPV" />, photos({ 'Falcon FPV': SRC }))).toContain(
      '<img',
    );
  });

  it('marking the same address twice is the same as once', () => {
    markPhotoFailed(SRC);
    markPhotoFailed(SRC);
    forgetFailedPhotos();
    expect(render(<ClientAvatar client="Falcon FPV" />, photos({ 'Falcon FPV': SRC }))).toContain(
      '<img',
    );
  });
});
