// Per-room QR-code window state. Used to be entirely local — every
// peer had their own text input and their own logo — but the host
// often wants to flash a shared QR on stream (a Bitcoin address, an
// event URL, an invite link), so the QR text + center logo are now
// broadcast across the mesh.
//
// `text` is the value rendered as a QR. `logoDataUrl` is an optional
// PNG data URL that gets punched through the middle of the QR (the
// QrCodeWindow downscales any drag-dropped image to 256×256 before
// sending it here, so payload size stays bounded — ~340 KB ceiling
// for a fully-opaque PNG, much less for typical logos).
//
// Last-writer-wins. Not persisted; the room's QR resets to empty on
// relay restart, and the client re-seeds it from the room URL on the
// next mount.

export type QrSnapshot = {
  text: string;
  logoDataUrl: string | null;
};

const DEFAULT_SNAPSHOT: QrSnapshot = {
  text: "",
  logoDataUrl: null,
};

type Listener = (snapshot: QrSnapshot) => void;

export class QrState {
  private snapshot: QrSnapshot = { ...DEFAULT_SNAPSHOT };
  private listeners: Listener[] = [];

  current(): { state: QrSnapshot } {
    return { state: this.snapshot };
  }

  /** Apply a partial patch. `logoDataUrl: null` clears the logo;
   *  omitting `logoDataUrl` from the patch preserves it. */
  setPatch(patch: Partial<QrSnapshot>): QrSnapshot {
    this.snapshot = { ...this.snapshot, ...patch };
    this.notify();
    return this.snapshot;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.snapshot);
      } catch {
        /* ignore */
      }
    }
  }
}
