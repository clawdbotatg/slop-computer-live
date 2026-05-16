"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address, AddressInput } from "@scaffold-ui/components";
import { type Address as AddressType, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { Button, LoadingBar, TextField } from "~~/components/ui";
import { MultisigAbi } from "~~/contracts/multisig";
import type { Browser, Peer, PeerMeshState, TxRequest, WalletRecord } from "~~/hooks/usePeerMesh";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

// Default address shown in the "custom" impersonator input until the user
// types something else. Vitalik because it's the canonical address every
// dapp will gracefully degrade against.
export const IMPERSONATED_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as AddressType;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const BROWSER_HOST_URL = process.env.NEXT_PUBLIC_BROWSER_HOST_URL ?? "ws://localhost:8090";
const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

// Detect ENS names in the URL bar. We accept:
//   "clawdbotatg.eth"
//   "clawdbotatg.eth/some/path"
//   "https://clawdbotatg.eth"
//   "vitalik.eth.link" → NOT an ENS name (forwards to a real domain)
// Subdomains like "foo.bar.eth" also qualify. Trailing slash on the host
// is allowed.
const ENS_HOST_RE = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth)(\/.*)?$/i;

function extractEnsTarget(raw: string): { name: string; pathSuffix: string } | null {
  const trimmed = raw.trim().replace(/^https?:\/\//, "");
  const m = ENS_HOST_RE.exec(trimmed);
  if (!m) return null;
  return { name: m[1].toLowerCase(), pathSuffix: m[2] ?? "" };
}

// Hit the relay's ENS resolver. Returns the navigable gateway URL on
// success, or null if there's no contenthash / the codec is unsupported
// / the relay errored. Caller falls back to the normal HTTPS path.
async function resolveEnsName(name: string, pathSuffix: string): Promise<string | null> {
  try {
    const res = await fetch(`${RELAY_HTTP}/v1/ens/resolve?name=${encodeURIComponent(name)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; gateway?: string };
    if (!data.ok || !data.gateway) return null;
    // pathSuffix already starts with "/" (or is empty). The gateway URL
    // ends with a trailing slash; concatenate without doubling.
    if (!pathSuffix) return data.gateway;
    return data.gateway.replace(/\/$/, "") + pathSuffix;
  } catch {
    return null;
  }
}

// Server viewport — must match VIEWPORT_WIDTH / VIEWPORT_HEIGHT on the host.
// Inputs are sent in *server* coordinates so we scale client → server before
// emitting them.
const SERVER_W = 1280;
const SERVER_H = 800;

const isHttpUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const normaliseUrl = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (isHttpUrl(trimmed)) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+/.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
};

export type SharedBrowserProps = {
  browser: Browser;
  txRequests: TxRequest[];
  onNavigate: (url: string) => void;
  canControl: boolean;
  /** When a session wallet is deployed we route captured tx_requests
   *  into the multisig's signing queue instead of just displaying
   *  them locally. */
  wallet?: WalletRecord | null;
  walletProposeTx?: PeerMeshState["walletProposeTx"];
  /** Other connected peers — surfaced as picks in the impersonator
   *  dropdown so you can browse the dapp as if you were them. */
  peers?: Peer[];
  /** Local user's own address (and optional handle label) — included as
   *  an impersonator option so you can act as yourself without typing. */
  selfAddress?: string | null;
  selfLabel?: string | null;
  /** Local peer id — when the impersonator is the local user, we forward
   *  the captured tx to ourselves so the incoming modal pops on our own
   *  screen. */
  selfPeerId?: string | null;
  /** Pass captured eth_sendTransaction requests to a specific peer (the
   *  wallet that's being impersonated). The receiver shows a modal and,
   *  if accepted, broadcasts via their real wagmi wallet. */
  forwardTxToPeer?: PeerMeshState["forwardTxToPeer"];
};

export const SharedBrowser = ({
  browser,
  txRequests,
  onNavigate,
  canControl,
  wallet,
  walletProposeTx,
  peers,
  selfAddress,
  selfLabel,
  selfPeerId,
  forwardTxToPeer,
}: SharedBrowserProps) => {
  const [draft, setDraft] = useState(browser.url);
  const lastSeenUrlRef = useRef(browser.url);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [showTxPanel, setShowTxPanel] = useState(false);
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  // Tx requests captured directly from the browser-host WS — distinct from
  // the cross-peer txRequests prop which arrives via the relay. We merge
  // both for display so peers without a host subscription still see them.
  const [hostTxRequests, setHostTxRequests] = useState<TxRequest[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const publicClient = usePublicClient();
  // Latest wallet + propose-tx fn lives in a ref so the WS message
  // handler (which is captured by browser.id only — see the effect
  // dep array below) always sees the current values without
  // re-subscribing on every wallet mutation.
  const walletRef = useRef<WalletRecord | null>(wallet ?? null);
  const proposeRef = useRef<PeerMeshState["walletProposeTx"] | null>(walletProposeTx ?? null);
  const forwardRef = useRef<PeerMeshState["forwardTxToPeer"] | null>(forwardTxToPeer ?? null);
  const peersRef = useRef<Peer[]>(peers ?? []);
  const selfPeerIdRef = useRef<string | null>(selfPeerId ?? null);
  const selfAddressRef = useRef<string | null>(selfAddress ?? null);
  useEffect(() => {
    walletRef.current = wallet ?? null;
    proposeRef.current = walletProposeTx ?? null;
    forwardRef.current = forwardTxToPeer ?? null;
    peersRef.current = peers ?? [];
    selfPeerIdRef.current = selfPeerId ?? null;
    selfAddressRef.current = selfAddress ?? null;
  }, [wallet, walletProposeTx, forwardTxToPeer, peers, selfPeerId, selfAddress]);
  // Set when the host tells us the page navigated on its own (link click,
  // window.location, popup-redirect). We mirror that URL into mesh state
  // so all peers' URL bars update, but we must NOT echo it back as a
  // "navigate" — that'd re-fetch the same URL and waste a round trip.
  const incomingUrlRef = useRef<string | null>(null);
  // ChainId the headless browser-host is configured for — sent in `hello`.
  // The injected provider reports this back to the dapp, so any captured
  // eth_sendTransaction implicitly belongs to this chain unless the tx
  // params override it.
  const hostChainIdRef = useRef<number | null>(null);

  // ---- Impersonator picker --------------------------------------------------
  // Dropdown lets you act as: the deployed session wallet, any other
  // connected peer (or yourself), or a custom address typed in via
  // <AddressInput>. Whatever's effective is sent to the browser-host so
  // the injected window.ethereum reports that address.

  // Distinct participant entries (self + peers), deduped on lowercase
  // address. Self comes first so you can pick yourself without scrolling
  // through a busy room.
  const participants = useMemo(() => {
    const out: { address: AddressType; label: string }[] = [];
    const seen = new Set<string>();
    if (selfAddress && ADDRESS_RE.test(selfAddress)) {
      seen.add(selfAddress.toLowerCase());
      out.push({ address: selfAddress as AddressType, label: selfLabel ?? "you" });
    }
    for (const p of peers ?? []) {
      if (!p.address || !ADDRESS_RE.test(p.address)) continue;
      const k = p.address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ address: p.address as AddressType, label: p.handle ?? "peer" });
    }
    return out;
  }, [peers, selfAddress, selfLabel]);

  type ImpersonatorMode = "wallet" | `peer:${string}` | "custom";

  // Priority: 1) deployed wallet, 2) any peer in the room (other "guest"
  // watching), 3) self (you're alone — impersonate yourself rather than
  // vitalik), 4) custom fallback. Same logic feeds both the synchronous
  // useState initializer (so the first WS query carries the right
  // address) and the auto-pick effect (which catches the case where
  // wallet/peers aren't loaded yet at mount).
  const pickAutoMode = (): ImpersonatorMode | null => {
    if (wallet) return "wallet";
    const firstPeer = (peers ?? []).find(p => typeof p.address === "string" && ADDRESS_RE.test(p.address));
    if (firstPeer?.address) return `peer:${firstPeer.address}` as ImpersonatorMode;
    if (selfAddress && ADDRESS_RE.test(selfAddress)) return `peer:${selfAddress}` as ImpersonatorMode;
    return null;
  };

  const [impMode, setImpMode] = useState<ImpersonatorMode>(() => pickAutoMode() ?? "custom");
  const [customImpAddr, setCustomImpAddr] = useState<AddressType>(IMPERSONATED_ADDRESS);

  // Runs once: the moment the dropdown is still at its default (custom +
  // vitalik) AND something better is available, we upgrade. After the
  // upgrade fires once we never auto-switch again, so a user who
  // explicitly picked "custom" doesn't get yanked back.
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (autoPickedRef.current) return;
    if (impMode !== "custom" || customImpAddr !== IMPERSONATED_ADDRESS) return;
    const picked = pickAutoMode();
    if (!picked) return;
    autoPickedRef.current = true;
    setImpMode(picked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, peers, selfAddress, impMode, customImpAddr]);

  const effectiveImpersonator: AddressType = useMemo(() => {
    if (impMode === "wallet") return (wallet?.address as AddressType) ?? IMPERSONATED_ADDRESS;
    if (impMode === "custom") return customImpAddr;
    return impMode.slice(5) as AddressType; // strip "peer:" prefix
  }, [impMode, wallet?.address, customImpAddr]);

  // Ref versions so the WS-open effect (keyed only on browser.id) can
  // read the latest impersonator + participants without re-subscribing
  // on every state change.
  const impersonatorRef = useRef(effectiveImpersonator);
  useEffect(() => {
    impersonatorRef.current = effectiveImpersonator;
  }, [effectiveImpersonator]);
  const participantsRef = useRef(participants);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Keep the URL bar in sync with shared state, but don't clobber what the
  // user is in the middle of typing.
  useEffect(() => {
    if (browser.url !== lastSeenUrlRef.current) {
      lastSeenUrlRef.current = browser.url;
      setDraft(browser.url);
    }
  }, [browser.url]);

  // Connect to the browser-host's stream for this browser id. On every
  // shared-state URL change we send a "navigate" message so the headless
  // tab follows the URL bar.
  useEffect(() => {
    // First subscriber for a fresh tab decides its initial impersonator;
    // later subscribers just get whatever's already live (server sends
    // `impersonated` back in `hello`).
    const url =
      `${BROWSER_HOST_URL}/stream/${encodeURIComponent(browser.id)}` +
      `?url=${encodeURIComponent(browser.url)}` +
      `&impersonated=${encodeURIComponent(impersonatorRef.current)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnState("open");
    ws.onclose = () => {
      setConnState("closed");
      // Force re-sync from `hello` on the next reconnect so a stale
      // local pick doesn't override whatever the tab is now impersonating.
      setHelloReceived(false);
      lastSentImpRef.current = null;
      if (wsRef.current === ws) wsRef.current = null;
    };
    ws.onerror = () => setConnState("closed");
    ws.onmessage = ev => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.type === "frame" && typeof msg.data === "string") {
        setFrameSrc(`data:image/jpeg;base64,${msg.data}`);
        return;
      }
      // Host echoes the current impersonator on connect (`hello`) and on
      // every change (`impersonator_changed`). When the server's address
      // differs from our local pick we sync UP: another peer changed it,
      // so our dropdown should match. We avoid feedback by only syncing
      // when the message address doesn't already equal our effective.
      if ((msg.type === "hello" || msg.type === "impersonator_changed") && typeof msg.impersonated === "string") {
        if (msg.type === "hello") {
          setHelloReceived(true);
          if (typeof msg.chainId === "number") hostChainIdRef.current = msg.chainId;
        }
        const incoming = msg.impersonated;
        if (!ADDRESS_RE.test(incoming)) {
          /* fall through to other hello handling */
        } else if (incoming.toLowerCase() === impersonatorRef.current.toLowerCase()) {
          // Server agrees with our local pick — mark it as already-sent
          // so the set_impersonator effect doesn't fire a no-op.
          lastSentImpRef.current = incoming.toLowerCase();
        } else {
          // Server's authoritative impersonator differs from our local
          // pick (e.g. another peer changed it). Mirror it into our
          // dropdown state AND mark it as already-sent so the
          // set_impersonator effect doesn't bounce it right back.
          lastSentImpRef.current = incoming.toLowerCase();
          const liveWallet = walletRef.current;
          if (liveWallet && incoming.toLowerCase() === liveWallet.address.toLowerCase()) {
            setImpMode("wallet");
          } else {
            const match = participantsRef.current.find(p => p.address.toLowerCase() === incoming.toLowerCase());
            if (match) {
              setImpMode(`peer:${match.address}` as ImpersonatorMode);
            } else {
              setCustomImpAddr(incoming as AddressType);
              setImpMode("custom");
            }
          }
        }
        if (msg.type === "impersonator_changed") return;
        // hello: fall through to the url field below.
      }
      if (msg.type === "url" && typeof msg.url === "string") {
        // Page navigated server-side. Stash so the navigate-effect skips
        // sending this back, then update mesh state so all peers' URL
        // bars reflect the new location.
        incomingUrlRef.current = msg.url;
        onNavigate(msg.url);
        return;
      }
      if (msg.type === "tx_request") {
        const method = typeof msg.method === "string" ? msg.method : "";
        const params = Array.isArray(msg.params) ? msg.params : [];
        let to: string | null = null;
        let value: string | null = null;
        let calldata = "";
        if (method === "eth_sendTransaction" && params[0] && typeof params[0] === "object") {
          const tx = params[0] as { to?: unknown; value?: unknown; data?: unknown };
          to = typeof tx.to === "string" ? tx.to : null;
          value = typeof tx.value === "string" ? tx.value : null;
          calldata = typeof tx.data === "string" ? tx.data : JSON.stringify(tx);
        } else {
          calldata = JSON.stringify({ method, params });
        }
        const next: TxRequest = {
          from: "browser-host",
          browserId: browser.id,
          calldata,
          to,
          value,
          chainId: null,
          receivedAt: Date.now(),
        };
        setHostTxRequests(prev => [next, ...prev].slice(0, 50));

        // Route captured txs to the wallet being impersonated. The dapp
        // built this calldata assuming the impersonated address is the
        // sender, so it only makes sense to queue it on that same address.
        // Today we can only queue against the session wallet (relay's
        // propose flow is tied to walletGetCurrent), so we require the
        // impersonator to match. Anything else just lands in the local
        // tx panel.
        const w = walletRef.current;
        const propose = proposeRef.current;
        const imp = impersonatorRef.current;
        const impMatchesWallet = !!w && imp.toLowerCase() === w.address.toLowerCase();
        if (w && propose && publicClient && to && calldata.startsWith("0x") && impMatchesWallet) {
          void (async () => {
            try {
              const nonce = (await publicClient.readContract({
                address: w.address as AddressType,
                abi: MultisigAbi,
                functionName: "nonce",
              })) as bigint;
              const deadline = defaultDeadline();
              const target = to as AddressType;
              const valueWei = value && value !== "0x" ? BigInt(value) : 0n;
              const data = calldata as Hex;
              const execHash = computeExecHash({
                chainId: w.chainId,
                multisig: w.address as AddressType,
                nonce,
                deadline,
                target,
                value: valueWei,
                data,
              });
              propose({
                target,
                value: valueWei.toString(),
                data,
                deadline: deadline.toString(),
                nonce: nonce.toString(),
                execHash,
                source: "browser",
                browserId: browser.id,
              });
            } catch (err) {
              console.warn("[wallet] failed to enqueue browser tx", err);
            }
          })();
        }

        // Also: if the impersonator address belongs to a connected peer's
        // real wagmi wallet (or our own), forward the captured tx to that
        // peer so they can sign+broadcast it. Only eth_sendTransaction is
        // wired through to the receiver's IncomingTxModal today; sign
        // methods would need their own UI path.
        const forward = forwardRef.current;
        if (forward && method === "eth_sendTransaction") {
          const impLower = imp.toLowerCase();
          // selfPeerId is preferred for the self case (avoid scanning
          // peers if we already know who we are). Otherwise scan peers
          // for an address match — first hit wins. Skip when the
          // impersonator is the session wallet, which is a contract
          // (no peer at that address) and is already handled above.
          const isWalletAddr = !!w && impLower === w.address.toLowerCase();
          let targetPeerId: string | null = null;
          if (!isWalletAddr) {
            const selfAddr = selfAddressRef.current?.toLowerCase() ?? null;
            const selfId = selfPeerIdRef.current ?? null;
            if (selfAddr && selfAddr === impLower && selfId) {
              targetPeerId = selfId;
            } else {
              const match = peersRef.current.find(
                p => typeof p.address === "string" && p.address.toLowerCase() === impLower,
              );
              if (match) targetPeerId = match.id;
            }
          }
          if (targetPeerId) {
            // Prefer an explicit chainId in the tx params; otherwise fall
            // back to the host's configured chain. The receiver compares
            // this to wagmi's current chainId and offers a switch.
            let chainId: number | null = hostChainIdRef.current;
            const p0 = params[0];
            if (p0 && typeof p0 === "object") {
              const cid = (p0 as { chainId?: unknown }).chainId;
              if (typeof cid === "string" && cid.startsWith("0x")) chainId = parseInt(cid, 16);
              else if (typeof cid === "number") chainId = cid;
            }
            forward(targetPeerId, { browserId: browser.id, method, params, chainId });
          }
        }
        return;
      }
    };
    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
    // We intentionally only re-subscribe on browser.id, not browser.url —
    // URL changes are sent as navigate messages over the existing WS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.id]);

  // Push local impersonator picks to the headless tab. We compare against
  // the last value we *sent* (rather than the message we last received)
  // so an echo from the server doesn't bounce back as a redundant
  // set_impersonator. A blank lastSentRef means we haven't sent yet —
  // first non-matching value triggers the swap.
  const lastSentImpRef = useRef<string | null>(null);
  // Wait for `hello` before sending set_impersonator: on reconnect to an
  // existing tab, our local pick may be stale and the server's value is
  // authoritative. The `hello` handler updates lastSentImpRef and may
  // sync our local state — letting that run first avoids a spurious
  // tab-recreate on the server.
  const [helloReceived, setHelloReceived] = useState(false);
  useEffect(() => {
    if (!helloReceived) return;
    if (connState !== "open") return;
    if (!ADDRESS_RE.test(effectiveImpersonator)) return;
    const lower = effectiveImpersonator.toLowerCase();
    if (lastSentImpRef.current === lower) return;
    lastSentImpRef.current = lower;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_impersonator", address: effectiveImpersonator }));
  }, [effectiveImpersonator, connState, helloReceived]);

  // Reflect URL changes from the shared mesh state to the headless tab.
  // Skip when the URL change *originated* on the host (in-page link click,
  // popup-redirect, etc.) — sending navigate back would re-fetch the same
  // URL we're already on.
  useEffect(() => {
    if (connState !== "open") return;
    if (browser.url === incomingUrlRef.current) {
      incomingUrlRef.current = null;
      return;
    }
    const ws = wsRef.current;
    if (!ws) return;
    ws.send(JSON.stringify({ type: "navigate", url: browser.url }));
  }, [browser.url, connState]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canControl) return;
    // ENS short-circuit: if the typed value looks like a `.eth` name,
    // resolve the contenthash via the relay and navigate to the IPFS
    // gateway URL — skips eth.link / eth.limo entirely.
    const ens = extractEnsTarget(draft);
    if (ens) {
      const gateway = await resolveEnsName(ens.name, ens.pathSuffix);
      if (gateway) {
        onNavigate(gateway);
        return;
      }
      // Fall through to normal handling (which will likely 404, but
      // gives the user a visible error).
    }
    const next = normaliseUrl(draft);
    onNavigate(next);
  };

  const reload = () => {
    if (!canControl) return;
    // Send `reload` directly over the host WS — onNavigate(browser.url)
    // would round-trip through the relay with the same URL string, which
    // doesn't trigger our [browser.url]-keyed effect, so the headless
    // tab never sees a navigate. The host's `reload` handler also
    // recreates the tab if the renderer has crashed.
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "reload" }));
  };

  // ---- Input forwarding ----------------------------------------------------
  // The frame is rendered with object-fit: contain so it preserves the
  // server viewport's aspect ratio (1280:800) regardless of how the user has
  // resized the surrounding Window. Clicks in the letterbox bars map to no
  // valid server coordinate and are dropped; clicks within the image area
  // are scaled into server space.
  const computeImageRect = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const targetAspect = SERVER_W / SERVER_H;
    const stageAspect = rect.width / rect.height;
    let imgW: number;
    let imgH: number;
    if (stageAspect > targetAspect) {
      // Stage is wider than the image — bars on left/right.
      imgH = rect.height;
      imgW = imgH * targetAspect;
    } else {
      // Stage is taller — bars on top/bottom.
      imgW = rect.width;
      imgH = imgW / targetAspect;
    }
    const offsetX = rect.left + (rect.width - imgW) / 2;
    const offsetY = rect.top + (rect.height - imgH) / 2;
    return { offsetX, offsetY, imgW, imgH };
  }, []);

  const toServerCoords = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const r = computeImageRect();
      if (!r) return null;
      const localX = e.clientX - r.offsetX;
      const localY = e.clientY - r.offsetY;
      if (localX < 0 || localX > r.imgW || localY < 0 || localY > r.imgH) return null;
      return {
        x: (localX / r.imgW) * SERVER_W,
        y: (localY / r.imgH) * SERVER_H,
      };
    },
    [computeImageRect],
  );

  const sendInput = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({
      type: "mouse",
      event: "down",
      x: c.x,
      y: c.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({
      type: "mouse",
      event: "up",
      x: c.x,
      y: c.y,
      button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
    });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    sendInput({ type: "mouse", event: "move", x: c.x, y: c.y, button: "none" });
  };
  // Wheel events fire 60-120Hz natively. Without throttling we flood CDP
  // with mouseWheel events on every scroll, which appears to be what
  // wedges the screencast (frames stop arriving mid-scroll). Coalesce
  // deltas inside ~30ms windows and flush at the end with the summed
  // delta — gives smooth scroll without spamming the host.
  const wheelAccum = useRef({ dx: 0, dy: 0, x: 0, y: 0, scheduled: 0 });
  const flushWheel = useCallback(() => {
    const w = wheelAccum.current;
    w.scheduled = 0;
    if (w.dx === 0 && w.dy === 0) return;
    sendInput({ type: "wheel", x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy });
    w.dx = 0;
    w.dy = 0;
  }, [sendInput]);
  const onWheel = (e: React.WheelEvent) => {
    if (!canControl) return;
    const c = toServerCoords(e);
    if (!c) return;
    const w = wheelAccum.current;
    w.dx += e.deltaX;
    w.dy += e.deltaY;
    w.x = c.x;
    w.y = c.y;
    if (!w.scheduled) {
      w.scheduled = window.setTimeout(flushWheel, 30);
    }
  };
  // Capture key events on the stage when it has focus. Key events are
  // captured at the element level rather than window so typing in our URL
  // bar doesn't get swallowed by the canvas stand-in.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!canControl) return;
    // CDP keyDown with `text` produces the input directly — no separate
    // char event needed (and sending one would double-type printable keys).
    // Special keys (Delete, Backspace, arrows) come through with no text;
    // the server uses the windowsVirtualKeyCode it derives from key.
    const text = e.key.length === 1 ? e.key : undefined;
    sendInput({
      type: "key",
      event: "down",
      key: e.key,
      code: e.code,
      text,
      modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
    e.preventDefault();
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!canControl) return;
    sendInput({
      type: "key",
      event: "up",
      key: e.key,
      code: e.code,
      modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
    });
    e.preventDefault();
  };

  const txList = useMemo(() => {
    // Merge mesh-broadcast and host-direct streams. De-dupe on (calldata, to)
    // since the same tx comes via both paths once relay forwarding is on.
    const seen = new Set<string>();
    const out: TxRequest[] = [];
    for (const tx of [...hostTxRequests, ...txRequests]) {
      const key = `${tx.calldata}|${tx.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tx);
      if (out.length >= 10) break;
    }
    return out;
  }, [txRequests, hostTxRequests]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0a0612" }}>
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          gap: 6,
          padding: 6,
          background: "var(--slop-panel)",
          borderBottom: "1px solid rgba(255,62,201,0.2)",
        }}
      >
        <Button onClick={reload} aria-label="Reload">
          ↻
        </Button>
        <TextField
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="https://example.com"
          spellCheck={false}
          style={{ flex: 1 }}
          disabled={!canControl}
        />
        <Button variant="primary" type="submit" disabled={!canControl}>
          Go
        </Button>
      </form>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          fontSize: 11,
          color: "var(--slop-text-muted)",
          background: "rgba(255,62,201,0.06)",
          borderBottom: "1px solid rgba(255,62,201,0.15)",
        }}
        title="The injected window.ethereum reports this address as the connected wallet. Pick the deployed multisig, any participant, or a custom address."
      >
        <span style={{ color: connState === "open" ? "var(--slop-magenta, #ff3ec9)" : "#888" }}>◉</span>
        <span>Impersonating</span>
        <select
          value={impMode}
          onChange={e => setImpMode(e.target.value as ImpersonatorMode)}
          disabled={!canControl}
          style={{
            background: "rgba(0,0,0,0.4)",
            color: "var(--slop-text)",
            border: "1px solid rgba(255,62,201,0.3)",
            borderRadius: 3,
            font: "inherit",
            padding: "1px 4px",
            cursor: canControl ? "pointer" : "not-allowed",
          }}
        >
          {wallet ? (
            <option value="wallet">
              wallet — {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
            </option>
          ) : null}
          {participants.map(p => (
            <option key={p.address.toLowerCase()} value={`peer:${p.address}`}>
              {p.label} — {p.address.slice(0, 6)}…{p.address.slice(-4)}
            </option>
          ))}
          <option value="custom">custom…</option>
        </select>
        {impMode === "custom" ? (
          <div style={{ minWidth: 220, maxWidth: 340 }}>
            <AddressInput
              value={customImpAddr}
              placeholder="0x… or vitalik.eth"
              disabled={!canControl}
              onChange={next => setCustomImpAddr(((next ?? "") as AddressType) || IMPERSONATED_ADDRESS)}
            />
          </div>
        ) : (
          <Address address={effectiveImpersonator} size="xs" onlyEnsOrAddress />
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--slop-text-muted)" }}>{connState}</span>
        <button
          type="button"
          onClick={() => setShowTxPanel(v => !v)}
          style={{
            background: "transparent",
            border: 0,
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
            padding: 0,
            marginLeft: 8,
          }}
        >
          {txList.length} tx {showTxPanel ? "▾" : "▸"}
        </button>
      </div>

      {showTxPanel ? (
        <div
          style={{
            maxHeight: 160,
            overflow: "auto",
            background: "#06030d",
            borderBottom: "1px solid rgba(255,62,201,0.15)",
            fontFamily: "monospace",
            fontSize: 10,
            color: "var(--slop-text)",
          }}
        >
          {txList.length === 0 ? (
            <div style={{ padding: 8, color: "var(--slop-text-muted)" }}>
              no tx captured yet — interact with the dapp to see calldata here
            </div>
          ) : (
            txList.map((tx, i) => (
              <div
                key={i}
                style={{
                  padding: 8,
                  borderBottom: i === txList.length - 1 ? "none" : "1px dashed rgba(255,62,201,0.15)",
                }}
              >
                <div style={{ color: "var(--slop-text-muted)", marginBottom: 2 }}>
                  to {tx.to ? `${tx.to.slice(0, 10)}…${tx.to.slice(-4)}` : "—"}
                  {tx.value && tx.value !== "0x0" ? ` · value ${tx.value}` : ""}
                  {tx.chainId !== null ? ` · chain ${tx.chainId}` : ""}
                </div>
                <div style={{ wordBreak: "break-all" }}>{tx.calldata}</div>
              </div>
            ))
          )}
        </div>
      ) : null}

      <div
        ref={stageRef}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={e => e.preventDefault()}
        tabIndex={0}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          // Letterbox bars when the window aspect doesn't match 1280:800.
          background: "#06030d",
          outline: "none",
          cursor: canControl ? "default" : "not-allowed",
        }}
      >
        {frameSrc ? (
          <img
            src={frameSrc}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              // contain preserves the server's 1280:800 aspect ratio; the
              // input handlers compute the active image rect and drop clicks
              // landing in the letterbox bars.
              objectFit: "contain",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <LoadingBar
              cells={22}
              caption={
                connState === "open" ? "FETCHING DAPP" : connState === "connecting" ? "CONNECTING" : "HOST OFFLINE"
              }
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default SharedBrowser;
