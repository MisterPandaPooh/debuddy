import { db, NotFoundError } from './lib';
import { getUser } from './user.service';

export interface Order {
  id: string;
  userId: string;
  total: number;
  flagged?: boolean;
}

export class SaveError extends Error {}

export async function saveOrder(order: Order) {
  const user = await getUser(order.userId);
  if (order.total > 100) {
    await audit(order, user.email);
    order.flagged = true;
  } else {
    order.flagged = false;
  }
  try {
    await db.orders.insert(order);
  } catch (err) {
    console.error('insert failed', err);
    throw new SaveError();
  } finally {
    metrics.inc('orders.save');
  }
  return order.id;
}

async function audit(order: Order, email: string) {
  const entry = { orderId: order.id, email, at: Date.now() };
  await db.audit.insert(entry);
}

const metrics = { inc: (_name: string) => undefined };
