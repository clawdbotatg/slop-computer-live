"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import { QRCodeSVG } from "qrcode.react";
import { type Address as AddressType, type Hex, isAddress, parseEther } from "viem";
import { useAccount, useChainId, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";
import { LoadingBar } from "~~/components/ui";
import { MultisigAbi } from "~~/contracts/multisig";
import type { PeerMeshState } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";
import { computeExecHash, defaultDeadline } from "~~/utils/multisig";

// The Privacy Wallet desktop app — a personal, single-viewer window (like the
// Wallet) whose funds pass through Railgun on mainnet so the ETH you end up
// spending has no on-chain link to where it came from. All money movement is
// server-side (the relay drives kohaku-cli); this window is a phase-driven
// view over GET /v1/kohaku/state:
//
//   awaiting-deposit → shielding (POI maturation) → soaking (the big
//   anonymity progress bar) → wallet (send your clean ETH anywhere).
//
// ⚠️ Custody: while funds are inside, the slop box holds the keys — this is
// a custodial privacy service, stated plainly in the UI. Mainnet, small
// amounts, capped.
//
// Wallet mode deliberately does NOT embed WalletAssetsPanel / WalletChatPanel:
// those panels' send/propose affordances route through wagmi or the passkey —
// signers the user does not hold here (the relay does). A misleading "Send"
// that pops MetaMask for an address whose key lives on the box is worse than
// a plain form that calls the one endpoint that actually works.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";
const ACCENT = "var(--slop-magenta, #ff3ec9)";
const LIME = "var(--slop-lime, #aaff00)";

type KohakuView = {
  phase: "awaiting-deposit" | "shielding" | "soaking" | "withdrawing" | "wallet";
  busy: string | null;
  error: string | null;
  overCap: boolean;
  depositAddress: string | null;
  withdrawAddress: string | null;
  depositedEth: string;
  expectedNoteEth: string;
  withdrawnEth: string;
  pendingDepositEth: string;
  shieldTxHash: string | null;
  unshieldHash: string | null;
  shieldedAt: number | null;
  soakEndsAt: number | null;
  soakProgress: number;
  soakHours: number;
  anonymityShields: number;
  poolSpendableEth: string | null;
  poolPendingEth: string | null;
  activity: { at: number; text: string }[];
  caps: { maxDepositEth: string; maxSendEth: string; minDepositEth: string };
};

type StateResponse = {
  ok: boolean;
  configured: boolean;
  state: KohakuView | null;
  walletBalanceEth: string | null;
  rpcUrl: string | null;
  defaultRpcUrl: string;
};

export function PrivacyWalletWindow({ mesh, myAddress }: { mesh: PeerMeshState; myAddress: string | null }) {
  const slug = useRoomSlug();
  const [snap, setSnap] = useState<StateResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = useCallback(async () => {
    if (!myAddress) return;
    try {
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/kohaku/state`, slug), { credentials: "include" });
      if (!res.ok) {
        setFetchError(`relay ${res.status}`);
        return;
      }
      setSnap((await res.json()) as StateResponse);
      setFetchError(null);
    } catch (err) {
      setFetchError(`network: ${String(err).slice(0, 100)}`);
    }
  }, [myAddress, slug]);

  // Poll: fast while something is moving on-chain, relaxed otherwise.
  const phase = snap?.state?.phase ?? null;
  const busy = !!snap?.state?.busy;
  useEffect(() => {
    void refresh();
    const fast = busy || phase === "shielding" || phase === "withdrawing" || phase === "awaiting-deposit";
    const t = setInterval(() => void refresh(), fast ? 5_000 : 20_000);
    return () => clearInterval(t);
  }, [refresh, phase, busy]);

  const post = useCallback(
    async (path: string, body?: unknown): Promise<boolean> => {
      setOpBusy(true);
      setOpError(null);
      try {
        const res = await fetch(withSlug(`${RELAY_HTTP}${path}`, slug), {
          method: "POST",
          credentials: "include",
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !j.ok) {
          setOpError(j.error ?? `relay ${res.status}`);
          return false;
        }
        await refresh();
        return true;
      } catch (err) {
        setOpError(`network: ${String(err).slice(0, 100)}`);
        return false;
      } finally {
        setOpBusy(false);
      }
    },
    [slug, refresh],
  );

  // --- Signed out ----------------------------------------------------------
  if (!myAddress) {
    return (
      <Centered>
        <div style={{ fontSize: 12, color: "var(--slop-text, #eee)", textAlign: "center", maxWidth: 300 }}>
          Sign in with your wallet or passkey first — privacy funds need a durable owner.
        </div>
      </Centered>
    );
  }

  if (!snap) {
    return (
      <Centered>
        <div style={{ fontSize: 12, color: "var(--slop-text-muted, #999)" }}>{fetchError ?? "loading…"}</div>
      </Centered>
    );
  }

  if (!snap.configured) {
    return (
      <Centered>
        <div style={{ fontSize: 12, color: "var(--slop-text-muted, #999)", textAlign: "center", maxWidth: 300 }}>
          The privacy wallet isn&apos;t configured on this box (missing kohaku-cli / RPC / wallet password in the relay
          env).
        </div>
      </Centered>
    );
  }

  const s = snap.state;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "auto" }}>
      {/* Header strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(255,62,201,0.18)",
          background: "rgba(0,0,0,0.25)",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--slop-text, #eee)" }}>
            Privacy wallet
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--slop-accent, #7cf)" }}>
              {s ? phaseLabel(s.phase, s.busy) : "railgun · mainnet"}
            </span>
          </div>
          <div style={{ fontSize: 9, color: "var(--slop-text-muted, #888)" }}>
            custodial while inside — the box holds the keys until you send out
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setShowSettings(v => !v)}
            style={pillStyle(showSettings)}
            title="Settings (RPC)"
          >
            ⚙
          </button>
          <button type="button" onClick={() => void refresh()} style={pillStyle(false)} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {showSettings && (
        <div style={{ padding: "8px 12px 0", flexShrink: 0 }}>
          <SettingsPanel
            rpcUrl={snap.rpcUrl}
            defaultRpcUrl={snap.defaultRpcUrl}
            busy={opBusy}
            onSave={url => post("/v1/kohaku/settings", { rpcUrl: url })}
          />
        </div>
      )}

      {(opError || s?.error || fetchError) && (
        <div style={{ padding: "6px 12px", fontSize: 11, color: "#ff6b6b", flexShrink: 0, wordBreak: "break-word" }}>
          {opError ?? s?.error ?? fetchError}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        {!s ? (
          <IntroPanel onOpen={() => void post("/v1/kohaku/open")} busy={opBusy} />
        ) : s.phase === "awaiting-deposit" ? (
          <DepositPanel s={s} mesh={mesh} />
        ) : s.phase === "shielding" ? (
          <ShieldingPanel s={s} />
        ) : s.phase === "soaking" || s.phase === "withdrawing" ? (
          <SoakPanel
            s={s}
            busy={opBusy || s.phase === "withdrawing"}
            onWithdraw={() => void post("/v1/kohaku/withdraw")}
          />
        ) : (
          <WalletPanel
            s={s}
            balanceEth={snap.walletBalanceEth}
            opBusy={opBusy}
            onSend={(to, amountWei, max) => post("/v1/kohaku/send", max ? { to, max: true } : { to, amountWei })}
            onReopen={() => void post("/v1/kohaku/open")}
          />
        )}

        {s && s.activity.length > 0 && <ActivityLog entries={s.activity} />}
      </div>
    </div>
  );
}

function phaseLabel(phase: KohakuView["phase"], busy: string | null): string {
  if (busy) return `${busy}…`;
  switch (phase) {
    case "awaiting-deposit":
      return "awaiting deposit";
    case "shielding":
      return "confirming on-chain";
    case "soaking":
      return "soaking";
    case "withdrawing":
      return "withdrawing";
    case "wallet":
      return "clean wallet";
  }
}

// --- Phase panels -----------------------------------------------------------

function IntroPanel({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  return (
    <div style={panelStyle}>
      <SectionTitle>Fund your privacy wallet</SectionTitle>
      <div style={{ fontSize: 11, color: "var(--slop-text, #ddd)", lineHeight: 1.5 }}>
        Deposit ETH from any account → it&apos;s shielded into{" "}
        <a href="https://railgun.org" target="_blank" rel="noreferrer" style={{ color: ACCENT }}>
          Railgun
        </a>{" "}
        → it soaks in the private pool while the anonymity set grows → you withdraw to a fresh address with no on-chain
        link to the source, and send it anywhere.
      </div>
      <div style={{ fontSize: 10, color: "#ffb347", lineHeight: 1.5 }}>
        ⚠️ While funds are inside, the slop box holds the keys — this is a custodial privacy service, not self-custody.
        Mainnet, small amounts only.
      </div>
      <button type="button" onClick={onOpen} disabled={busy} style={bigButtonStyle(busy)}>
        {busy ? "opening…" : "Open privacy wallet"}
      </button>
    </div>
  );
}

function DepositPanel({ s, mesh }: { s: KohakuView; mesh: PeerMeshState }) {
  const [copied, setCopied] = useState(false);
  const [amountEth, setAmountEth] = useState("0.01");
  const [busyBtn, setBusyBtn] = useState<"wallet" | "bank" | null>(null);
  const [depErr, setDepErr] = useState<string | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);
  const [bankProposed, setBankProposed] = useState(false);
  const addr = s.depositAddress ?? "";
  const pending = Number(s.pendingDepositEth) > 0;

  const { isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const mainnetClient = usePublicClient({ chainId: 1 });
  const bank = mesh.wallet;
  const bankOnMainnet = !!bank && 1 in bank.deployments;

  const parseAmount = (): bigint | null => {
    setDepErr(null);
    let wei: bigint;
    try {
      wei = parseEther(amountEth.trim());
    } catch {
      setDepErr("enter an ETH amount, e.g. 0.01");
      return null;
    }
    const min = parseEther(s.caps.minDepositEth);
    const max = parseEther(s.caps.maxDepositEth);
    if (wei < min || wei > max) {
      setDepErr(`amount must be between ${s.caps.minDepositEth} and ${s.caps.maxDepositEth} ETH`);
      return null;
    }
    return wei;
  };

  // Plain ETH send from the user's connected wallet (pops MetaMask etc.),
  // pinned to mainnet — switches the chain first if needed.
  const depositFromWallet = async () => {
    const wei = parseAmount();
    if (wei === null || !addr) return;
    setBusyBtn("wallet");
    setSentHash(null);
    try {
      if (connectedChainId !== 1) await switchChainAsync({ chainId: 1 });
      const hash = await sendTransactionAsync({ to: addr as AddressType, value: wei, chainId: 1 });
      setSentHash(hash);
    } catch (e) {
      setDepErr(String(e).slice(0, 160));
    } finally {
      setBusyBtn(null);
    }
  };

  // Propose a plain transfer from the room's Bank multisig to the deposit
  // address — same recipe as the wager payout propose (nonce + execHash
  // computed client-side, relay queues it for signatures in the Bank app).
  const depositFromBank = async () => {
    const wei = parseAmount();
    if (wei === null || !addr) return;
    if (!bank) return setDepErr("this room has no Bank multisig yet");
    if (!bankOnMainnet) return setDepErr("the Bank isn't deployed on mainnet");
    if (!mainnetClient) return setDepErr("no mainnet RPC client");
    setBusyBtn("bank");
    setBankProposed(false);
    try {
      const nonce = (await mainnetClient.readContract({
        address: bank.address as AddressType,
        abi: MultisigAbi,
        functionName: "nonce",
      })) as bigint;
      const deadline = defaultDeadline();
      const execHash = computeExecHash({
        chainId: 1,
        multisig: bank.address as AddressType,
        nonce,
        deadline,
        target: addr as AddressType,
        value: wei,
        data: "0x" as Hex,
      });
      mesh.walletProposeTx({
        chainId: 1,
        target: addr,
        value: wei.toString(),
        data: "0x",
        deadline: deadline.toString(),
        nonce: nonce.toString(),
        execHash,
        source: "manual",
        browserId: null,
      });
      setBankProposed(true);
    } catch (e) {
      setDepErr(String(e).slice(0, 160));
    } finally {
      setBusyBtn(null);
    }
  };

  return (
    <div style={panelStyle}>
      <SectionTitle>Deposit ETH</SectionTitle>
      <div style={{ fontSize: 11, color: "var(--slop-text, #ddd)" }}>
        Fund your privacy wallet with mainnet ETH — it auto-shields into Railgun on arrival.
      </div>

      {/* Amount + one-tap sources */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          inputMode="decimal"
          value={amountEth}
          onChange={e => setAmountEth(e.target.value)}
          placeholder={`ETH (${s.caps.minDepositEth}–${s.caps.maxDepositEth})`}
          disabled={busyBtn !== null}
          style={{ ...inputStyle, width: 110, flexShrink: 0 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
          <button
            type="button"
            onClick={() => void depositFromWallet()}
            disabled={busyBtn !== null}
            style={bigButtonStyle(busyBtn !== null)}
            title={isConnected ? "Send from your connected wallet" : "Pops your wallet to connect + send"}
          >
            {busyBtn === "wallet" ? "confirm in wallet…" : "Deposit from wallet"}
          </button>
          <button
            type="button"
            onClick={() => void depositFromBank()}
            disabled={busyBtn !== null || !bankOnMainnet}
            style={bigButtonStyle(busyBtn !== null || !bankOnMainnet, true)}
            title={
              bankOnMainnet
                ? "Propose a transfer from the room's Bank multisig"
                : "Bank multisig isn't deployed on mainnet"
            }
          >
            {busyBtn === "bank" ? "proposing…" : "Deposit from Bank"}
          </button>
        </div>
      </div>
      {depErr && <div style={{ fontSize: 11, color: "#ff6b6b", wordBreak: "break-word" }}>{depErr}</div>}
      {sentHash && (
        <div style={{ fontSize: 11, color: LIME }}>
          sent — watching for arrival, auto-shields shortly. <TxLink hash={sentHash} label="tx" />
        </div>
      )}
      {bankProposed && (
        <div style={{ fontSize: 11, color: LIME }}>
          proposed to the Bank — open the Bank app to sign &amp; execute it.
        </div>
      )}

      {/* Manual: QR + address for any outside account */}
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)" }}>…or send from any outside account:</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ background: "#fff", padding: 6, borderRadius: 4, flexShrink: 0 }}>
          <QRCodeSVG value={addr} size={96} />
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <Address address={addr as AddressType} size="sm" />
          <button
            type="button"
            style={pillStyle(copied)}
            onClick={() => {
              void navigator.clipboard.writeText(addr);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "copied ✓" : "copy address"}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)" }}>
        min {s.caps.minDepositEth} ETH · max {s.caps.maxDepositEth} ETH
        {s.overCap ? " — your deposit exceeds the cap; contact the host" : ""}
      </div>
      {pending && (
        <div style={{ fontSize: 11, color: LIME }}>
          incoming {s.pendingDepositEth} ETH spotted — confirming, shielding shortly…
        </div>
      )}
    </div>
  );
}

// RPC settings — mirrors the video-share settings idea: a gear on the window,
// one setting inside. The URL is stored + validated RELAY-side (it's the
// relay that talks to the RPC on your behalf), so pasting your own node here
// keeps a third-party endpoint from ever seeing your privacy-wallet queries.
function SettingsPanel({
  rpcUrl,
  defaultRpcUrl,
  busy,
  onSave,
}: {
  rpcUrl: string | null;
  defaultRpcUrl: string;
  busy: boolean;
  onSave: (url: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(rpcUrl ?? "");
  const [saved, setSaved] = useState<string | null>(null);
  const usingCustom = !!rpcUrl;

  const save = async (url: string) => {
    setSaved(null);
    const ok = await onSave(url);
    if (ok) {
      setSaved(url ? "saved — your ops now use this RPC" : "reset to default");
      if (!url) setDraft("");
    }
  };

  return (
    <div style={{ ...panelStyle, gap: 8 }}>
      <SectionTitle>Settings</SectionTitle>
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)", lineHeight: 1.5 }}>
        Mainnet RPC for your privacy-wallet operations. Defaults to BuidlGuidl&apos;s community nodes — paste your own
        node&apos;s public URL for maximum privacy (it must be reachable from the relay, i.e. not a LAN address).
      </div>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder={defaultRpcUrl}
        disabled={busy}
        spellCheck={false}
        style={{ ...inputStyle, fontFamily: "monospace", fontSize: 11 }}
      />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void save(draft.trim())}
          disabled={busy || !draft.trim()}
          style={pillStyle(true)}
        >
          {busy ? "checking…" : "Save"}
        </button>
        {usingCustom && (
          <button type="button" onClick={() => void save("")} disabled={busy} style={pillStyle(false)}>
            use default
          </button>
        )}
        <span style={{ fontSize: 10, color: usingCustom ? LIME : "var(--slop-text-muted, #888)" }}>
          {saved ?? (usingCustom ? "using your RPC" : `using default (${defaultRpcUrl.replace(/^https?:\/\//, "")})`)}
        </span>
      </div>
    </div>
  );
}

function ShieldingPanel({ s }: { s: KohakuView }) {
  return (
    <div style={panelStyle}>
      <SectionTitle>Confirming on-chain</SectionTitle>
      <Spinner label={`shielded ${s.depositedEth} ETH into Railgun — waiting for spendability (~30–45 min)`} />
      {s.shieldTxHash && <TxLink hash={s.shieldTxHash} label="shield tx" />}
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)", lineHeight: 1.5 }}>
        Railgun&apos;s proof-of-innocence check has to mature before your private balance is spendable. The soak timer
        starts now either way.
      </div>
      <SoakBar s={s} />
    </div>
  );
}

function SoakPanel({ s, busy, onWithdraw }: { s: KohakuView; busy: boolean; onWithdraw: () => void }) {
  const [armed, setArmed] = useState(false);
  const done = s.soakProgress >= 1;
  const withdrawing = s.phase === "withdrawing" || s.busy === "withdrawing";
  return (
    <div style={panelStyle}>
      <SectionTitle>Soaking in the private pool</SectionTitle>
      <SoakBar s={s} />
      <div style={{ fontSize: 12, color: LIME, fontWeight: 600 }}>
        anonymity set: +{s.anonymityShields} shields since your deposit
      </div>
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)", lineHeight: 1.5 }}>
        Every Railgun shield that lands after yours makes your withdrawal harder to link. Withdrawing early is allowed
        but weakens that crowd.
        {s.poolSpendableEth != null && (
          <>
            {" "}
            Pool: {s.poolSpendableEth} spendable / {s.poolPendingEth ?? "0"} settling.
          </>
        )}
      </div>
      {withdrawing ? (
        <Spinner label="unshielding to a fresh unlinked address (gas paid from the private balance)…" />
      ) : done || armed ? (
        <button type="button" onClick={onWithdraw} disabled={busy} style={bigButtonStyle(busy)}>
          {busy ? "withdrawing…" : armed && !done ? "really withdraw early?" : "Withdraw to a fresh address"}
        </button>
      ) : (
        <button type="button" onClick={() => setArmed(true)} disabled={busy} style={bigButtonStyle(busy, true)}>
          Withdraw early (smaller anonymity set)
        </button>
      )}
    </div>
  );
}

function WalletPanel({
  s,
  balanceEth,
  opBusy,
  onSend,
  onReopen,
}: {
  s: KohakuView;
  balanceEth: string | null;
  opBusy: boolean;
  onSend: (to: string, amountWei: string, max: boolean) => Promise<boolean>;
  onReopen: () => void;
}) {
  const [to, setTo] = useState("");
  const [amountEth, setAmountEth] = useState("");
  const [sendMax, setSendMax] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const balance = balanceEth != null ? Number(balanceEth) : null;
  const empty = balance != null && balance < Number(s.caps.minDepositEth);

  const submit = useCallback(async () => {
    setLocalError(null);
    const dest = to.trim();
    if (!isAddress(dest)) {
      setLocalError("destination must be a 0x… address");
      return;
    }
    let amountWei = "0";
    if (!sendMax) {
      const n = Number(amountEth);
      if (!(n > 0)) {
        setLocalError("enter an ETH amount (or tick max)");
        return;
      }
      // gwei-granular: ETH → gwei in float (safe range), then ×1e9 in BigInt.
      amountWei = (BigInt(Math.round(n * 1e9)) * 1_000_000_000n).toString();
    }
    const ok = await onSend(dest, amountWei, sendMax);
    if (ok) {
      setTo("");
      setAmountEth("");
      setSendMax(false);
    }
  }, [to, amountEth, sendMax, onSend]);

  return (
    <div style={panelStyle}>
      <SectionTitle>Your clean wallet</SectionTitle>
      <div>
        <div
          style={{
            fontSize: 10,
            color: "var(--slop-text-muted, #999)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          Balance
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--slop-text, #eee)" }}>
          {balanceEth != null ? `${Number(balanceEth).toFixed(5)} ETH` : "…"}
        </div>
        {s.withdrawAddress && <Address address={s.withdrawAddress as AddressType} size="sm" />}
      </div>
      {s.unshieldHash && <TxLink hash={s.unshieldHash} label="unshield" />}
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)", lineHeight: 1.5 }}>
        This address has no on-chain link to your deposit source. Send it to your own wallet to regain self-custody —
        until then the box still holds this key.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          type="text"
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="Destination address (0x…)"
          disabled={opBusy}
          style={inputStyle}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            inputMode="decimal"
            value={sendMax ? (balanceEth ?? "") : amountEth}
            onChange={e => setAmountEth(e.target.value)}
            placeholder="ETH amount"
            disabled={opBusy || sendMax}
            style={{ ...inputStyle, flex: 1 }}
          />
          <label
            style={{
              fontSize: 11,
              color: "var(--slop-text-muted, #999)",
              display: "flex",
              gap: 4,
              alignItems: "center",
            }}
          >
            <input type="checkbox" checked={sendMax} onChange={e => setSendMax(e.target.checked)} disabled={opBusy} />
            max
          </label>
        </div>
        <button type="button" onClick={() => void submit()} disabled={opBusy} style={bigButtonStyle(opBusy)}>
          {opBusy ? "sending…" : "Send"}
        </button>
        <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)" }}>
          capped at {s.caps.maxSendEth} ETH per send
        </div>
        {localError && <div style={{ fontSize: 11, color: "#ff6b6b" }}>{localError}</div>}
      </div>

      {empty && (
        <button type="button" onClick={onReopen} disabled={opBusy} style={pillStyle(false)}>
          start a new cycle
        </button>
      )}
    </div>
  );
}

// --- Bits -------------------------------------------------------------------

function SoakBar({ s }: { s: KohakuView }) {
  const pct = Math.round(s.soakProgress * 100);
  const remainMs = s.soakEndsAt ? Math.max(0, s.soakEndsAt - Date.now()) : 0;
  const remainH = Math.floor(remainMs / 3_600_000);
  const remainM = Math.round((remainMs % 3_600_000) / 60_000);
  return (
    <div>
      <LoadingBar cells="fill" progress={pct} caption="" style={{ fontSize: 14 }} />
      <div style={{ fontSize: 10, color: "var(--slop-text-muted, #999)", marginTop: 3 }}>
        {pct}% of the {s.soakHours}h soak{remainMs > 0 ? ` — ${remainH}h ${remainM}m left` : " — done"}
      </div>
    </div>
  );
}

function ActivityLog({ entries }: { entries: { at: number; text: string }[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);
  return (
    <div style={{ ...panelStyle, gap: 4, maxHeight: 140, overflow: "auto" }}>
      <SectionTitle>Activity</SectionTitle>
      {entries.map((e, i) => (
        <div key={`${e.at}-${i}`} style={{ fontSize: 10, color: "var(--slop-text-muted, #aaa)", lineHeight: 1.4 }}>
          <span style={{ color: "var(--slop-text-muted, #777)" }}>
            {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>{" "}
          {e.text}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "var(--slop-text, #ddd)" }}>
      <span
        style={{
          width: 12,
          height: 12,
          border: `2px solid ${ACCENT}`,
          borderTopColor: "transparent",
          borderRadius: "50%",
          display: "inline-block",
          animation: "spin 0.9s linear infinite",
          flexShrink: 0,
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {label}
    </div>
  );
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <div style={{ fontSize: 11, color: "var(--slop-accent, #7cf)", wordBreak: "break-all" }}>
      {label}:{" "}
      <a
        href={`https://etherscan.io/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--slop-accent, #7cf)" }}
      >
        {hash.slice(0, 10)}…{hash.slice(-8)}
      </a>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--slop-text-muted, #999)",
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        fontWeight: 700,
      }}
    >
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 16, display: "grid", placeItems: "center", height: "100%" }}>{children}</div>;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(255,62,201,0.3)",
  borderRadius: 6,
  padding: 12,
  background: "rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  flexShrink: 0,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  fontSize: 12,
  background: "rgba(0,0,0,0.35)",
  color: "var(--slop-text, #eee)",
  border: "1px solid rgba(255,62,201,0.25)",
  borderRadius: 4,
  outline: "none",
};

function bigButtonStyle(busy: boolean, subtle = false): React.CSSProperties {
  return {
    padding: "10px 12px",
    fontSize: 12,
    fontWeight: 700,
    fontFamily: "var(--slop-font-display, monospace)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    background: subtle ? "transparent" : "rgba(255,62,201,0.2)",
    color: subtle ? "var(--slop-text-muted, #999)" : ACCENT,
    border: `1px solid rgba(255,62,201,${subtle ? "0.25" : "0.5"})`,
    borderRadius: 4,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.6 : 1,
  };
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    fontSize: 11,
    fontFamily: "var(--slop-font-display, monospace)",
    letterSpacing: "0.06em",
    background: active ? "rgba(255,62,201,0.2)" : "transparent",
    color: active ? ACCENT : "var(--slop-text-muted, #999)",
    border: "1px solid rgba(255,62,201,0.3)",
    borderRadius: 4,
    cursor: "pointer",
  };
}
