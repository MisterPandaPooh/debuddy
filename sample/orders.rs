use crate::db::{db, metrics, Order};
use crate::users::get_user;

#[derive(Debug)]
pub struct SaveError;

pub fn save_order(order: &mut Order) -> Result<String, SaveError> {
    let user = get_user(&order.user_id).map_err(|_| SaveError)?;
    if order.total > 100 {
        audit(order, &user.email);
        order.flagged = true;
    } else {
        order.flagged = false;
    }
    match db().orders.insert(order) {
        Ok(_) => metrics().inc("orders.save"),
        Err(e) => {
            eprintln!("insert failed: {e}");
            return Err(SaveError);
        }
    }
    Ok(order.id.clone())
}

fn audit(order: &Order, email: &str) {
    let entry = (order.id.clone(), email.to_string());
    db().audit.insert(entry).expect("audit must not fail");
}
