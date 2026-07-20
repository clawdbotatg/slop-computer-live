"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Portfolio } from "./wallet/types";
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

// Shield — a personal, single-viewer window (like the Wallet) that passes
// your ETH through Railgun on mainnet so what comes out has no on-chain link
// to where it came from. A pass-through, not a resident wallet: the honest
// pitch is "ETH in linked to you, ETH out clean" (the internal app id stays
// "privacy"). All money movement is server-side (the relay drives EF's
// kohaku-cli); this window is a phase-driven view over GET /v1/kohaku/state:
//
//   awaiting-deposit → shielding (POI maturation) → soaking (the big
//   anonymity progress bar) → wallet (holdings / chat / send).
//
// ⚠️ Custody: while funds are inside, the slop box holds the keys — this is
// a custodial privacy service, stated plainly in the UI. Mainnet, small
// amounts, capped.
//
// Wallet mode deliberately does NOT embed WalletAssetsPanel / WalletChatPanel:
// those panels' send/propose affordances route through wagmi or the passkey —
// signers the user does not hold here (the relay does). Holdings is a slim
// read-only Zerion view; chat proposals execute only via the confirm chip →
// the capped /v1/kohaku/send.

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
  depositSuggestions?: { depositEth: string; exitEth: string }[];
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
          Shield isn&apos;t configured on this box (missing kohaku-cli / RPC / wallet password in the relay env).
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
            Shield
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
      <SectionTitle>Shield your ETH</SectionTitle>
      <div style={{ fontSize: 11, color: "var(--slop-text, #ddd)", lineHeight: 1.5 }}>
        Pass your ETH through{" "}
        <a href="https://railgun.org" target="_blank" rel="noreferrer" style={{ color: ACCENT }}>
          Railgun
        </a>
        &apos;s private pool and withdraw it with no on-chain history: deposit → auto-shield → soak while the anonymity
        set grows → withdraw to a fresh address → spend or send it anywhere. Powered by Railgun via EF&apos;s Kohaku.
      </div>
      <div style={{ fontSize: 10, color: "#ffb347", lineHeight: 1.5 }}>
        ⚠️ While funds are inside, the slop box holds the keys — this is a custodial privacy service, not self-custody.
        Mainnet, small amounts only. To STAY anonymous afterwards, send the clean ETH to a fresh wallet — not one the
        world already knows is yours.
      </div>
      <button type="button" onClick={onOpen} disabled={busy} style={bigButtonStyle(busy)}>
        {busy ? "opening…" : "Open your Shield"}
      </button>
    </div>
  );
}

function DepositPanel({ s, mesh }: { s: KohakuView; mesh: PeerMeshState }) {
  const [copied, setCopied] = useState(false);
  // Default to the padded deposit that exits as a clean 0.01 — the most
  // common Railgun exit size at our scale (field-measured, 2026-07).
  const suggestions = s.depositSuggestions ?? [];
  const [amountEth, setAmountEth] = useState(() => suggestions.find(x => x.exitEth === "0.01")?.depositEth ?? "0.01");
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
      {suggestions.length > 0 && (
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "var(--slop-text-muted, #888)" }}>clean exits:</span>
          {suggestions.slice(-3).map(x => (
            <button
              key={x.exitEth}
              type="button"
              onClick={() => setAmountEth(x.depositEth)}
              style={{ ...pillStyle(amountEth === x.depositEth), fontSize: 9, padding: "2px 6px" }}
              title={`Deposit ${x.depositEth} to withdraw a clean ${x.exitEth} — blends with the most common Railgun exit sizes`}
            >
              {x.depositEth} → {x.exitEth} out
            </button>
          ))}
        </div>
      )}
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
  const [tab, setTab] = useState<"holdings" | "chat" | "send">("holdings");
  const balance = balanceEth != null ? Number(balanceEth) : null;
  const empty = balance != null && balance < Number(s.caps.minDepositEth);

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
        This address has no on-chain link to your deposit source — but the box still holds its key. Send to a FRESH
        wallet to regain self-custody AND stay anonymous; sending to a wallet the world knows is yours publicly ties the
        clean ETH back to you.
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,62,201,0.18)" }}>
        {(["holdings", "chat", "send"] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "6px 10px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display, monospace)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontWeight: 700,
              background: "transparent",
              color: t === tab ? ACCENT : "var(--slop-text-muted, #999)",
              border: "none",
              borderBottom: t === tab ? `2px solid ${ACCENT}` : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "holdings" && s.withdrawAddress && <HoldingsTab address={s.withdrawAddress} />}
      {tab === "chat" && <ChatTab opBusy={opBusy} onSend={onSend} />}
      {tab === "send" && <SendTab s={s} balanceEth={balanceEth} opBusy={opBusy} onSend={onSend} />}

      {empty && (
        <button type="button" onClick={onReopen} disabled={opBusy} style={pillStyle(false)}>
          start a new cycle
        </button>
      )}
    </div>
  );
}

// Read-only Zerion holdings for the clean address, via the relay's existing
// /v1/wallet/portfolio proxy (the same feed the Wallet/Bank apps use). No
// send affordances here — those panels sign via wagmi/passkey, keys this
// wallet's user doesn't hold. Sends live in the Send/Chat tabs → relay.
function HoldingsTab({ address }: { address: string }) {
  const slug = useRoomSlug();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/wallet/portfolio?address=${address}`, slug), {
        credentials: "include",
      });
      if (!res.ok) {
        setErr(`portfolio: relay ${res.status}`);
        return;
      }
      setPf((await res.json()) as Portfolio);
    } catch (e) {
      setErr(String(e).slice(0, 100));
    } finally {
      setLoading(false);
    }
  }, [address, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const assets = (pf?.assets ?? []).filter(a => Number(a.balanceUsd) > 0.005 || Number(a.balance) > 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--slop-text, #eee)" }}>
          {pf ? `$${Number(pf.totalBalanceUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "…"}
        </div>
        <button type="button" onClick={() => void load()} style={pillStyle(false)} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </div>
      {err && <div style={{ fontSize: 11, color: "#ff6b6b" }}>{err}</div>}
      {pf && assets.length === 0 && (
        <div style={{ fontSize: 11, color: "var(--slop-text-muted, #999)" }}>nothing here yet</div>
      )}
      {assets.map((a, i) => (
        <div
          key={`${a.contractAddress}-${a.blockchain}-${i}`}
          style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--slop-text, #ddd)" }}
        >
          <span>
            {a.tokenSymbol}
            <span style={{ marginLeft: 6, fontSize: 9, color: "var(--slop-text-muted, #888)" }}>{a.blockchain}</span>
          </span>
          <span>
            {Number(a.balance).toLocaleString("en-US", { maximumFractionDigits: 5 })}
            <span style={{ marginLeft: 6, color: "var(--slop-text-muted, #999)" }}>
              ${Number(a.balanceUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// "Talk to your funds" — chat over /v1/kohaku/chat. The model only PROPOSES
// sends; nothing moves until the confirm chip fires the capped send endpoint.
type ChatMsg = {
  who: "you" | "shield";
  text: string;
  proposal?: { to: string; toLabel: string; amountEth: string; max: boolean };
  proposalDone?: boolean;
};

function ChatTab({
  opBusy,
  onSend,
}: {
  opBusy: boolean;
  onSend: (to: string, amountWei: string, max: boolean) => Promise<boolean>;
}) {
  const slug = useRoomSlug();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [msgs.length]);

  const say = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs(m => [...m, { who: "you", text }]);
    setBusy(true);
    try {
      const res = await fetch(withSlug(`${RELAY_HTTP}/v1/kohaku/chat`, slug), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        reply?: string;
        proposal?: ChatMsg["proposal"] | null;
      };
      if (!res.ok || !j.ok) {
        setMsgs(m => [...m, { who: "shield", text: j.error ?? `relay ${res.status}` }]);
      } else {
        setMsgs(m => [...m, { who: "shield", text: j.reply ?? "…", proposal: j.proposal ?? undefined }]);
      }
    } catch (e) {
      setMsgs(m => [...m, { who: "shield", text: `network: ${String(e).slice(0, 80)}` }]);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (idx: number, p: NonNullable<ChatMsg["proposal"]>) => {
    const amountWei = p.max ? "0" : parseEther(p.amountEth).toString();
    const ok = await onSend(p.to, amountWei, p.max);
    if (ok) {
      setMsgs(m => m.map((msg, i) => (i === idx ? { ...msg, proposalDone: true } : msg)));
      setMsgs(m => [...m, { who: "shield", text: "sent ✓ — details in the activity log" }]);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ maxHeight: 200, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {msgs.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--slop-text-muted, #999)" }}>
            ask your funds anything — &quot;how much do I have?&quot;, &quot;send 0.002 to vitalik.eth&quot;…
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ fontSize: 11, lineHeight: 1.45 }}>
            <span style={{ color: m.who === "you" ? "var(--slop-accent, #7cf)" : ACCENT, fontWeight: 700 }}>
              {m.who === "you" ? "you" : "shield"}:
            </span>{" "}
            <span style={{ color: "var(--slop-text, #ddd)", whiteSpace: "pre-wrap" }}>{m.text}</span>
            {m.proposal && !m.proposalDone && (
              <button
                type="button"
                onClick={() => void confirm(i, m.proposal!)}
                disabled={opBusy}
                style={{ ...pillStyle(true), display: "block", marginTop: 4 }}
              >
                {opBusy
                  ? "sending…"
                  : `confirm: send ${m.proposal.max ? "max" : `${m.proposal.amountEth} ETH`} → ${m.proposal.toLabel}`}
              </button>
            )}
            {m.proposal && m.proposalDone && (
              <span style={{ marginLeft: 6, fontSize: 10, color: LIME }}>✓ executed</span>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") void say();
          }}
          placeholder="talk to your funds…"
          disabled={busy}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button type="button" onClick={() => void say()} disabled={busy || !input.trim()} style={pillStyle(true)}>
          {busy ? "…" : "send"}
        </button>
      </div>
    </div>
  );
}

function SendTab({
  s,
  balanceEth,
  opBusy,
  onSend,
}: {
  s: KohakuView;
  balanceEth: string | null;
  opBusy: boolean;
  onSend: (to: string, amountWei: string, max: boolean) => Promise<boolean>;
}) {
  const [to, setTo] = useState("");
  const [amountEth, setAmountEth] = useState("");
  const [sendMax, setSendMax] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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
