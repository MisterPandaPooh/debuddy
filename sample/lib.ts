export interface User { id: string; email: string }
export interface Role { name: string; revokedAt?: number; source?: string }
export class NotFoundError extends Error {}

interface Collection<T> {
  find(id: string): Promise<T | null>;
  findOne(q: object): Promise<T | null>;
  insert(doc: T): Promise<void>;
}
export const db = {
  users: {} as Collection<User>,
  roles: {} as Collection<{ userId: string; roles: Role[] }>,
  orders: {} as Collection<{ id: string; userId: string; total: number; flagged?: boolean }>,
  audit: {} as Collection<{ orderId: string; email: string; at: number }>,
};
