import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { Server } from '@pkg/contracts';
import { ServersCard, serverPatch, resetsPin } from '@/features/servers/servers-card';
import { render, screen, waitFor } from '../../mocks/providers';
import { installRadixDomShims, makeAction } from '../projects/helpers';

/**
 * Strings are translation KEYS: the test i18n (mocks/i18n.ts) returns the key
 * for every lookup.
 *
 * Editing a registered server without deleting it: the dialog is pre-filled,
 * only changed fields go on the wire (the backend resets the pinned fingerprint
 * whenever host/port is PRESENT), the reset is announced before saving, an
 * empty role set cannot be saved, and a name collision lands on the field.
 */

const hooks = vi.hoisted(() => ({
  useServers: vi.fn(),
  useCreateServer: vi.fn(),
  useUpdateServer: vi.fn(),
  useRemoveServer: vi.fn(),
  useTestServer: vi.fn(),
  useInvalidateServers: vi.fn(),
}));

vi.mock('@/shared/servers/hooks', () => hooks);
vi.mock('@/shared/hooks/use-permissions', () => ({ useCan: () => true }));

const box: Server = {
  id: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  name: 'box-1',
  host: 'box.example.com',
  port: 22,
  sshUser: 'deploy',
  roles: ['app'],
  publicKey: 'ssh-ed25519 AAAA test',
  hostFingerprint: 'SHA256:pinned',
  status: 'reachable',
  lastCheckedAt: '2026-09-05T10:00:00.000Z',
  createdBy: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

let update: ReturnType<typeof makeAction>;

beforeAll(() => installRadixDomShims());

beforeEach(() => {
  update = makeAction();
  hooks.useServers.mockReturnValue({ data: { data: [box], meta: { total: 1 } }, canList: true });
  hooks.useCreateServer.mockReturnValue(makeAction());
  hooks.useUpdateServer.mockReturnValue(update);
  hooks.useRemoveServer.mockReturnValue(makeAction());
  hooks.useTestServer.mockReturnValue(makeAction());
});

async function openEdit() {
  const user = userEvent.setup();
  render(<ServersCard />);
  await user.click(screen.getByRole('button', { name: 'servers.edit' }));
  await screen.findByRole('dialog');
  return user;
}

describe('serverPatch — only changed fields go on the wire', () => {
  it('is empty when the form matches the server', () => {
    const patch = serverPatch(box, {
      name: box.name,
      host: box.host,
      port: '22',
      sshUser: box.sshUser,
      roles: ['app'],
    });
    expect(patch).toEqual({});
    expect(resetsPin(patch)).toBe(false);
  });

  it('a roles/name/sshUser change never carries host or port, so the pin survives', () => {
    const patch = serverPatch(box, {
      name: 'box-renamed',
      host: box.host,
      port: '22',
      sshUser: 'ops',
      roles: ['app', 'runner'],
    });
    expect(patch).toEqual({ name: 'box-renamed', sshUser: 'ops', roles: ['app', 'runner'] });
    expect(resetsPin(patch)).toBe(false);
  });

  it('a host or port change is flagged as a pin reset', () => {
    expect(resetsPin(serverPatch(box, { ...formOf(box), host: 'new.example.com' }))).toBe(true);
    expect(resetsPin(serverPatch(box, { ...formOf(box), port: '2222' }))).toBe(true);
  });
});

const formOf = (s: Server) => ({
  name: s.name,
  host: s.host,
  port: String(s.port),
  sshUser: s.sshUser,
  roles: s.roles,
});

describe('ServersCard — edit dialog', () => {
  it('opens pre-filled with the server’s current values', async () => {
    await openEdit();
    expect(screen.getByLabelText('servers.name')).toHaveValue('box-1');
    expect(screen.getByLabelText('servers.host')).toHaveValue('box.example.com');
    expect(screen.getByLabelText('servers.port')).toHaveValue('22');
    expect(screen.getByLabelText('servers.sshUser')).toHaveValue('deploy');
    expect(screen.getByRole('checkbox', { name: 'servers.role.app' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'servers.role.runner' })).not.toBeChecked();
    // Nothing changed yet → nothing to save.
    expect(screen.getByRole('button', { name: 'servers.save' })).toBeDisabled();
  });

  it('adding a role PATCHes only {id, roles} — no host/port, no fingerprint reset', async () => {
    const user = await openEdit();
    await user.click(screen.getByRole('checkbox', { name: 'servers.role.runner' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'servers.save' }));
    await waitFor(() => expect(update.execute).toHaveBeenCalledTimes(1));
    expect(update.execute).toHaveBeenCalledWith({ id: box.id, roles: ['app', 'runner'] });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('warns BEFORE saving when the host changes, then sends only the host', async () => {
    const user = await openEdit();
    const host = screen.getByLabelText('servers.host');
    await user.clear(host);
    await user.type(host, 'new.example.com');
    expect(screen.getByRole('alert')).toHaveTextContent('servers.pinResetWarning');
    await user.click(screen.getByRole('button', { name: 'servers.save' }));
    await waitFor(() =>
      expect(update.execute).toHaveBeenCalledWith({ id: box.id, host: 'new.example.com' }),
    );
  });

  it('cannot save an empty role set', async () => {
    const user = await openEdit();
    await user.click(screen.getByRole('checkbox', { name: 'servers.role.app' }));
    expect(screen.getByText('servers.rolesRequired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'servers.save' })).toBeDisabled();
    expect(update.execute).not.toHaveBeenCalled();
  });

  it('surfaces a name collision on the name field and keeps the dialog open', async () => {
    update = makeAction(vi.fn(async () => ({ e: new Error('servers.errors.nameTaken'), d: null })));
    update.error = new Error('servers.errors.nameTaken');
    hooks.useUpdateServer.mockReturnValue(update);
    const user = await openEdit();
    const name = screen.getByLabelText('servers.name');
    await user.clear(name);
    await user.type(name, 'box-2');
    await user.click(screen.getByRole('button', { name: 'servers.save' }));
    await waitFor(() => expect(update.execute).toHaveBeenCalledWith({ id: box.id, name: 'box-2' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('servers.errors.nameTaken')).toBeInTheDocument();
  });
});
