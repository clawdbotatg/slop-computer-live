import { type Address, type Hex, getAddress } from "viem";
import { type SafeTx, webAuthnSigData } from "~~/utils/safe";

// The wedgie hardware signer over Web Serial (desktop Chrome / Edge only),
// running the Safe signer app (clawdbotatg/wedgie-safe). One JSON line each way:
//   {"id":1,"type":"hello"}            -> {"safe": {"x","y"} | null, ...}
//   {"id":2,"type":"safe_sign","tx":…} -> {"type":"safe_sig", safeTxHash, r, s, authenticatorData, clientDataFields}
//                                         | {"type":"refused"}
// The device hashes the tx itself, shows it, and signs only on a real A press.
// Its key sits behind a Safe passkey signer contract, same as a passkey.
// Prototype security: never the only owner, never enough alone (ops/PLAN-safe.md).
// Ported from clawdbotatg/instant-wallet web/lib/safe/wedgie.ts.

const RPI_VID = 0x2e8a;

type Pending = { res: (v: any) => void; rej: (e: Error) => void; t: number };

export const wedgieSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

let holder: Wedgie | null = null;

export class Wedgie {
  private port: any;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private line = "";
  private next = 100;
  private pending = new Map<number, Pending>();

  /** Open the wedgie (asks for the port the first time — needs a click). */
  static async connect(): Promise<Wedgie> {
    if (!wedgieSupported()) throw new Error("This browser can't talk to a wedgie. Use Chrome or Edge on a computer.");
    if (holder) throw new Error("The wedgie is busy with another transaction.");
    const serial = (navigator as any).serial;
    const known = (await serial.getPorts()).filter((p: any) => p.getInfo().usbVendorId === RPI_VID);
    const port = known[0] ?? (await serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] }));
    const w = new Wedgie();
    w.port = port;
    await port.open({ baudRate: 115200 });
    w.writer = port.writable.getWriter();
    w.reader = port.readable.getReader();
    void w.read();
    holder = w;
    return w;
  }

  private async read() {
    const dec = new TextDecoder("latin1");
    try {
      while (true) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        this.line += dec.decode(value);
        let i;
        while ((i = this.line.indexOf("\n")) >= 0) {
          const l = this.line
            .slice(0, i)
            .replace(/\r$/, "")
            .replace(/^[\x04>]*(OK)?/, "");
          this.line = this.line.slice(i + 1);
          if (!l.startsWith("{")) continue;
          try {
            const v = JSON.parse(l);
            const p = typeof v.id === "number" ? this.pending.get(v.id) : undefined;
            if (p) {
              clearTimeout(p.t);
              this.pending.delete(v.id);
              p.res(v);
            }
          } catch {
            /* not ours */
          }
        }
      }
    } catch {
      /* port closed */
    }
    if (holder === this) holder = null;
    for (const [, p] of this.pending) p.rej(new Error("wedgie unplugged"));
    this.pending.clear();
  }

  private request(msg: Record<string, unknown>, ms = 5000): Promise<any> {
    const id = this.next++;
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => {
        this.pending.delete(id);
        rej(new Error("The wedgie didn't answer. Is it running the Safe signer app?"));
      }, ms);
      this.pending.set(id, { res, rej, t });
      this.writer!.write(new TextEncoder().encode(JSON.stringify({ ...msg, id }) + "\n")).catch(rej);
    });
  }

  /** The wedgie's P-256 public key. */
  async key(): Promise<{ x: Hex; y: Hex }> {
    const h = await this.request({ type: "hello" }, 5000);
    if (!h?.safe) throw new Error("The wedgie has no Safe key yet: press A on it to make one, then try again.");
    return { x: h.safe.x, y: h.safe.y };
  }

  /** One A press signs `t`. Returns the signer-contract payload (store as sigType 1). */
  async sign(chainId: number, safe: Address, t: SafeTx, expectHash: Hex): Promise<Hex> {
    const tx = {
      chainId,
      safe: getAddress(safe),
      to: getAddress(t.to),
      value: t.value.toString(),
      data: t.data,
      operation: t.operation,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: Number(t.nonce),
    };
    if (JSON.stringify(tx).length > 6000) throw new Error("Too big for the wedgie to show (6 KB max). Split it up.");
    const g = await this.request({ type: "safe_sign", tx }, 200_000);
    if (g?.type === "refused") throw new Error("Refused on the wedgie.");
    if (g?.type !== "safe_sig") throw new Error("The wedgie said something unexpected.");
    if (String(g.safeTxHash).toLowerCase() !== expectHash.toLowerCase()) {
      throw new Error("The wedgie signed a different transaction. Not using it.");
    }
    return webAuthnSigData({
      authenticatorData: g.authenticatorData,
      clientDataFields: g.clientDataFields,
      r: BigInt(g.r),
      s: BigInt(g.s),
    });
  }

  async close() {
    if (holder === this) holder = null;
    try {
      await this.reader?.cancel();
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {
      /* already gone */
    }
  }
}

/** Connect, run `fn`, always release the port. */
export async function withWedgie<T>(fn: (w: Wedgie) => Promise<T>): Promise<T> {
  const w = await Wedgie.connect();
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}
