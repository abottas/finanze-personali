const te = new TextEncoder();
export async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}
