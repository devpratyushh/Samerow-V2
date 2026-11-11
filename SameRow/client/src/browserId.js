export function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// randomUUID is unavailable on plain HTTP LAN addresses.
export function browserId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const value = randomHex(16);
  const variant = (8 + (parseInt(value[16], 16) & 3)).toString(16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-${variant}${value.slice(17, 20)}-${value.slice(20)}`;
}
