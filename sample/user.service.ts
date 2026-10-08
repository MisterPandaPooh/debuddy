import { db, NotFoundError, Role, User } from './lib';

export async function getUser(id: string) {
  const user = await db.users.find(id);
  if (!user) throw new NotFoundError();
  const roles = await getRoles(user);
  return { ...user, roles };
}

export async function getRoles(user: User): Promise<Role[]> {
  const doc = await db.roles.findOne({ userId: user.id });
  if (!doc) return [];
  const active = doc.roles.filter((r) => !r.revokedAt || r.revokedAt > Date.now());
  return active.map((r) => ({ ...r, source: 'db' }));
}
