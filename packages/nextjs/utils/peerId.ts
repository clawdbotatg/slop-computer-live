// Per-tab peer ID. Survives reload (sessionStorage) but not new tabs.
// Later: replace with SIWE-signed wallet address.

const KEY = "slop-peer-id";

export function getOrCreatePeerId(): string {
  if (typeof window === "undefined") return "";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}
