// Kept separate from Firebase initialization so API helpers and previews can be
// imported without opening a network session.
let tokenProvider = async () => '';
export function configureSession(provider) { tokenProvider = provider; }
export async function sessionHeaders() {
  const token = await tokenProvider();
  return token ? { 'X-SameRow-Token': token } : {};
}
