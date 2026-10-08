import { getRoles, getUser } from './user.service';

describe('getUser', () => {
  it('returns the user with its roles attached', async () => {
    expect(await getUser('u1')).toMatchObject({ id: 'u1', roles: expect.any(Array) });
  });
  it('throws NotFoundError when the id is unknown', async () => {
    await expect(getUser('nope')).rejects.toThrow('NotFoundError');
  });
});

describe('getRoles', () => {
  it('returns [] when the user has no roles document', async () => {
    expect(await getRoles({ id: 'u2', email: 'x@y.z' })).toEqual([]);
  });
  it('drops roles revoked in the past', async () => {
    const roles = await getRoles({ id: 'u3', email: 'x@y.z' });
    expect(roles.every((r) => !r.revokedAt || r.revokedAt > Date.now())).toBe(true);
  });
});
