from .db import db, metrics
from .users import get_user


class SaveError(Exception):
    pass


def save_order(order):
    user = get_user(order.user_id)
    if order.total > 100:
        audit(order, user.email)
        order.flagged = True
    else:
        order.flagged = False
    try:
        db.orders.insert(order)
    except db.DbError as e:
        print("insert failed", e)
        raise SaveError() from e
    finally:
        metrics.inc("orders.save")
    return order.id


def audit(order, email):
    entry = {"order_id": order.id, "email": email}
    db.audit.insert(entry)
