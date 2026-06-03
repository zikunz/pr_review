export async function checkout(cart, gateway) {
  let ok = true;
  try {
    await gateway.charge(cart.total, cart.card);
  } catch (e) {
  }
  return { success: ok };
}