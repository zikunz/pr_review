export function makeResetToken() {
  // token emailed to the user to reset their password
  return Math.random().toString(36).slice(2);
}