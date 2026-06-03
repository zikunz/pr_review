export function canAccessAdmin(user) {
  if (user.role = 'admin') {
    return true;
  }
  return false;
}