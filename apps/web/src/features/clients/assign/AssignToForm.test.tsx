import { describe, expect, it } from 'vitest';
import { TEAM_KEY } from '@/data/team-query';
import { createTestQueryClient, makeTeam } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { AssignToForm } from './AssignToForm';

const client = { clientId: 'aaaaaaaaaaaa', name: 'Arc Fitness' };

function render(team: ReturnType<typeof makeTeam> | null, phone = false) {
  const queryClient = createTestQueryClient();
  if (team !== null) queryClient.setQueryData(TEAM_KEY, team);
  return renderAt(
    '/clients',
    <AssignToForm client={client} onDone={() => {}} phone={phone} />,
    queryClient,
  );
}

const checkboxes = (markup: string) => markup.match(/<button [^>]*role="checkbox"[^>]*>/g) ?? [];

describe('<AssignToForm>', () => {
  it('has a checkbox per editor, with their name and login, ticked for the ones the client has', async () => {
    const markup = await render(makeTeam());
    const boxes = checkboxes(markup);
    expect(boxes).toHaveLength(2);
    // Sorted by name: Amit, Yael. Arc Fitness is assigned to Yael.
    expect(boxes[0]).toContain('aria-checked="false"');
    expect(boxes[1]).toContain('aria-checked="true"');
    expect(markup.indexOf('Amit')).toBeLessThan(markup.indexOf('Yael'));
    expect(markup).toContain('amit@example.com');
    expect(markup).toContain('yael@example.com');
  });

  it('points each label at its checkbox', async () => {
    const markup = await render(makeTeam());
    for (const box of checkboxes(markup)) {
      const id = box.match(/id="([^"]+)"/)?.[1];
      expect(markup).toContain(`for="${id}"`);
    }
  });

  it('leaves admins out: they see every client already', async () => {
    const team = makeTeam();
    team.users.push({ email: 'zed@example.com', name: 'Zed', role: 'admin' });
    const markup = await render(team);
    expect(checkboxes(markup)).toHaveLength(2);
    expect(markup).not.toContain('Zed');
  });

  it('ticks nobody for a client no one has, and Save is a submit button', async () => {
    const markup = await render(makeTeam({ assignments: {} }));
    for (const box of checkboxes(markup)) expect(box).toContain('aria-checked="false"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Save<\/button>/);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Cancel<\/button>/);
    expect(markup).toMatch(/<form[^>]*>/);
  });

  it('says there are no editors yet, and links to the Team page, when there are none', async () => {
    const markup = await render(makeTeam({ users: [], assignments: {} }));
    expect(checkboxes(markup)).toHaveLength(0);
    expect(markup).toContain('There are no editors yet.');
    expect(markup).toContain('href="/settings/team"');
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it('waits for the team without ticking anything or letting Save go', async () => {
    const markup = await render(null);
    expect(markup).toContain('Loading the team…');
    expect(checkboxes(markup)).toHaveLength(0);
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it('makes the rows taller on the phone', async () => {
    expect(await render(makeTeam(), true)).toContain('min-h-12');
    expect(await render(makeTeam(), false)).toContain('min-h-10');
  });
});
