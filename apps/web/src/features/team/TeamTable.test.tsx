import { describe, expect, it } from 'vitest';
import { makeTeam } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { TeamTable } from './TeamTable';

const render = (props: Partial<Parameters<typeof TeamTable>[0]> = {}) =>
  renderAt('/', <TeamTable team={makeTeam()} skeletonDelayMs={0} {...props} />);

const rows = (markup: string) =>
  [...markup.matchAll(/<tr[^>]*data-team-email="[^"]+"[\s\S]*?<\/tr>/g)].map((m) =>
    [...m[0].matchAll(/<td[\s\S]*?<\/td>/g)].map((td) => td[0].replace(/<[^>]*>/g, '').trim()),
  );

describe('<TeamTable>', () => {
  it('has Name, Login, Role and Clients columns, named Team', async () => {
    const markup = await render();
    expect(markup).toContain('aria-label="Team"');
    const headers = (markup.match(/<th[\s\S]*?<\/th>/g) ?? []).map((th) =>
      th.replace(/<[^>]*>/g, '').trim(),
    );
    expect(headers).toEqual(['Name', 'Login', 'Role', 'Clients']);
  });

  it('lists the two people with their role and the clients assigned to them', async () => {
    expect(rows(await render())).toEqual([
      ['Yael', 'yael@example.com', 'Editor', 'Arc Fitness'],
      ['Amit', 'amit@example.com', 'Editor', 'None yet'],
    ]);
  });

  it('lists several clients of one person as plain text', async () => {
    const team = makeTeam({
      assignments: {
        a: { client: 'Arc Fitness', editors: ['yael@example.com'] },
        b: { client: 'Kova Coffee', editors: ['yael@example.com', 'amit@example.com'] },
      },
    });
    const listed = rows(await render({ team }));
    expect(listed[0]?.[3]).toBe('Arc Fitness, Kova Coffee');
    expect(listed[1]?.[3]).toBe('Kova Coffee');
  });

  it('says an admin has every client', async () => {
    const team = makeTeam({ users: [{ email: 'zed@example.com', name: 'Zed', role: 'admin' }] });
    expect(rows(await render({ team }))).toEqual([
      ['Zed', 'zed@example.com', 'Admin', 'All clients'],
    ]);
  });

  it('tells a person with no name by their login', async () => {
    const team = makeTeam({ users: [{ email: 'dana@example.com', name: '', role: 'editor' }] });
    expect(rows(await render({ team }))[0]?.[0]).toBe('dana@example.com');
  });

  it('says "No one on the team yet." for an empty team', async () => {
    const markup = await render({ team: makeTeam({ users: [], assignments: {} }) });
    expect(markup).toContain('No one on the team yet.');
    expect(markup).toContain('Add person');
  });

  it('shows skeleton rows while the first answer is on its way, and a retry when it failed', async () => {
    const loading = await render({ team: undefined });
    expect(loading).toContain('data-skeleton-row');
    expect(loading).toContain('Loading the team…');
    const failed = await render({ team: undefined, failed: true });
    expect(failed).toContain('Can&#x27;t reach the engine.');
    expect(failed).not.toContain('data-skeleton-row');
  });

  it('makes each row reachable by keyboard, for the menu key', async () => {
    const tag =
      (await render()).match(/<tr[^>]*data-team-email="yael@example.com"[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('tabindex="0"');
    expect(tag).toContain('aria-label="Yael, Editor"');
  });
});
