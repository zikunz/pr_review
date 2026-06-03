export async function findOrder(req, db) {
  const orderId = req.query.orderId;
  return db.query(`SELECT * FROM orders WHERE id = ${orderId}`);
}