"use client";

import { useCallback, useMemo, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { parseAbi, parseEventLogs } from "viem";
import { base } from "viem/chains";
import { useAccount, usePublicClient, useSignMessage, useSwitchChain, useWalletClient, useWriteContract } from "wagmi";
import { Button, LoadingBar } from "~~/components/ui";
import type { LeftclawPayment, LeftclawServiceId, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useRoomSlug } from "~~/lib/room-slug";
import { withSlug } from "~~/lib/slug";

// Post a Research / Build / Audit job to Leftclaw Services. The shared
// phase/step lives on the relay (leftclaw-state.ts) and broadcasts to every
// peer, so spectators watch the post go out and read the resulting job link.
// The signing + on-chain tx happen HERE, in the driver's browser — the relay
// only proxies the CORS-blocked Leftclaw HTTP and tracks the advisory phase.
//
// Two payment paths:
//   • CV    — sign "larv.ai CV Spend", burn CV off-chain (relay proxy), then
//             send postJobWithCV on Base (needs ETH for gas).
//   • USDC  — gasless x402 (EIP-3009); the @x402 SDK drives 402→sign→retry
//             through the relay proxy and the Leftclaw server posts the job.

const RELAY_HTTP = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

const LEFTCLAW_BASE = "https://leftclaw.services";
const LEFTCLAW_CONTRACT = "0xb2fb486a9569ad2c97d9c73936b46ef7fdaa413a" as const;

const LEFTCLAW_ABI = parseAbi([
  "function serviceTypes(uint256) view returns (uint256 id, string name, string slug, uint256 priceUsd, uint256 cvDivisor, string status)",
  "function postJobWithCV(uint256 serviceTypeId, uint256 cvAmount, string description)",
  "event JobPosted(uint256 indexed jobId, address indexed client, uint256 indexed serviceTypeId, uint256 clawdAmount, uint256 priceUsd, uint8 paymentMethod, uint256 cvAmount)",
]);

type Service = {
  id: LeftclawServiceId;
  slug: "research" | "audit" | "build";
  label: string;
  priceUsd: number;
  blurb: string;
};

const SERVICES: Service[] = [
  {
    id: 7,
    slug: "research",
    label: "Research",
    priceUsd: 3,
    blurb: "Deep research report on a protocol, topic, or codebase.",
  },
  { id: 4, slug: "audit", label: "Audit", priceUsd: 4, blurb: "AI security audit of a smart contract." },
  { id: 6, slug: "build", label: "Build", priceUsd: 20, blurb: "Full SE-2 dApp build, contracts → frontend → deploy." },
];

const PANEL_BG = "#0a061a";
const ACCENT = "var(--slop-magenta, #ff3ec9)";
const CYAN = "var(--slop-cyan, #38f9f9)";
const BORDER = "1px solid rgba(255,62,201,0.25)";

export const LeftclawWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const st = mesh.leftclawState;
  const slug = useRoomSlug();
  const { address, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: base.id });

  // Local form (stays local until "Post" — only transitions broadcast).
  const [serviceId, setServiceId] = useState<LeftclawServiceId>(7);
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
  const [payment, setPayment] = useState<LeftclawPayment>("cv");

  const posting = st.phase === "posting";
  const done = st.phase === "done";
  const errored = st.phase === "error";
  const service = useMemo(() => SERVICES.find(s => s.id === serviceId)!, [serviceId]);

  const fail = useCallback(
    (msg: string) => {
      console.warn("leftclaw post failed:", msg);
      mesh.leftclawError(msg);
    },
    [mesh],
  );

  const post = useCallback(async () => {
    if (!address || !publicClient) return;
    const desc = description.trim();
    if (!desc) return;

    // Take the room lock first (refused with 409 if someone's mid-post).
    const startRes = await mesh.leftclawStart({
      serviceTypeId: serviceId,
      description: desc,
      context: context.trim(),
      paymentMethod: payment,
    });
    if (!startRes.ok) {
      // 409 = another peer is already posting; their broadcast drives the UI.
      return;
    }

    try {
      // Both paths sign on Base — make sure the wallet is actually there
      // before doing anything irreversible. A swallowed switch failure
      // would otherwise let us burn CV against the wrong chain.
      if (chainId !== base.id) {
        mesh.leftclawUpdate("Switching to Base…");
        try {
          await switchChainAsync({ chainId: base.id });
        } catch {
          throw new Error("Switch your wallet to Base, then post again.");
        }
      }

      if (payment === "cv") {
        // 1. Price: cvAmount = ceil((highestCVBalance / 5) / cvDivisor)
        mesh.leftclawUpdate("Reading CV price…");
        const svc = await publicClient.readContract({
          address: LEFTCLAW_CONTRACT,
          abi: LEFTCLAW_ABI,
          functionName: "serviceTypes",
          args: [BigInt(serviceId)],
        });
        const cvDivisor = Number(svc[4]);
        const highRes = await fetch(withSlug(`${RELAY_HTTP}/v1/leftclaw/cv-highest`, slug), { credentials: "include" });
        const highJson = (await highRes.json()) as { highestCVBalance?: number };
        const highest = Number(highJson.highestCVBalance);
        if (!Number.isFinite(highest) || !Number.isFinite(cvDivisor) || cvDivisor <= 0) {
          throw new Error("could not compute CV cost");
        }
        const cvAmount = BigInt(Math.ceil(highest / 5 / cvDivisor));
        const fullDesc = context.trim() ? `${desc}\n\nContext: ${context.trim()}` : desc;

        // 2. Simulate the on-chain post BEFORE burning CV. CV is spent
        // off-chain and can't be refunded, so a doomed post (bad service,
        // empty desc, RPC reachability) must fail here — never after the
        // burn. Returns the validated request we then submit verbatim.
        // (Note: this can't catch a wallet that mangles tx *submission* —
        // e.g. MetaMask Smart Transactions; that's a wallet-side issue and
        // the USDC path avoids it entirely.)
        mesh.leftclawUpdate("Checking the job will post…");
        const { request } = await publicClient.simulateContract({
          account: address,
          address: LEFTCLAW_CONTRACT,
          abi: LEFTCLAW_ABI,
          functionName: "postJobWithCV",
          args: [BigInt(serviceId), cvAmount, fullDesc],
        });

        // 3. Sign the static CV spend authorization (EIP-191 personal sign).
        mesh.leftclawUpdate("Signing CV spend…");
        const signature = await signMessageAsync({ message: "larv.ai CV Spend" });

        // 4. Burn CV off-chain (relay proxy — Leftclaw has no CORS).
        mesh.leftclawUpdate("Burning CV…");
        const spendRes = await fetch(withSlug(`${RELAY_HTTP}/v1/leftclaw/cv-spend`, slug), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: address, signature, amount: Number(cvAmount) }),
        });
        const spendJson = await spendRes.json().catch(() => ({}));
        if (!spendRes.ok || !spendJson?.success) {
          throw new Error(`CV burn failed: ${spendJson?.error ?? spendRes.status}`);
        }

        // 5. Post the job on-chain with the pre-validated request.
        mesh.leftclawUpdate("Posting on-chain…");
        const hash = await writeContractAsync(request);

        mesh.leftclawUpdate("Confirming…");
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const events = parseEventLogs({ abi: LEFTCLAW_ABI, eventName: "JobPosted", logs: receipt.logs });
        const jobId = events[0]?.args?.jobId != null ? Number(events[0].args.jobId) : NaN;
        if (!Number.isFinite(jobId)) throw new Error("posted, but could not read jobId from receipt");
        mesh.leftclawDone({ jobId, txHash: hash });
      } else {
        // USDC x402 — gasless. The @x402 SDK drives 402→sign→retry through the
        // relay proxy; the Leftclaw server settles + posts the job itself.
        if (!walletClient) throw new Error("wallet client not ready");
        mesh.leftclawUpdate("Signing USDC payment…");
        const [{ wrapFetchWithPaymentFromConfig }, { ExactEvmScheme, toClientEvmSigner }] = await Promise.all([
          import("@x402/fetch"),
          import("@x402/evm"),
        ]);
        const rawSigner = toClientEvmSigner(walletClient as any, publicClient as any);
        // wagmi's walletClient exposes the address at .account.address, not
        // .address — override so the EIP-3009 `from` isn't undefined.
        const signer = { ...rawSigner, address };
        const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
          schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(signer as any) }],
        });
        const res = await fetchWithPayment(withSlug(`${RELAY_HTTP}/v1/leftclaw/x402/${service.slug}`, slug), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description: desc, context: context.trim() || undefined }),
        });
        if (!res.ok) throw new Error(`x402 post failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
        const result = (await res.json()) as { jobId?: number; jobUrl?: string };
        if (!Number.isFinite(Number(result.jobId))) throw new Error("server did not return a jobId");
        mesh.leftclawDone({ jobId: Number(result.jobId), jobUrl: result.jobUrl });
      }
    } catch (err: any) {
      fail(err?.shortMessage ?? err?.message ?? String(err));
    }
  }, [
    address,
    chainId,
    publicClient,
    walletClient,
    description,
    context,
    serviceId,
    payment,
    service.slug,
    slug,
    mesh,
    switchChainAsync,
    signMessageAsync,
    writeContractAsync,
    fail,
  ]);

  // ---- Done screen ---------------------------------------------------------
  if (done) {
    const jobUrl = st.jobUrl ?? `${LEFTCLAW_BASE}/jobs/${st.jobId}`;
    const postedLabel = SERVICES.find(s => s.id === st.serviceTypeId)?.label ?? "Job";
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: CYAN, letterSpacing: 1, textTransform: "uppercase" }}>
            {postedLabel} job posted
          </div>
          <div style={{ fontSize: 40, fontWeight: 800, color: ACCENT, margin: "8px 0" }}>#{st.jobId}</div>
          <a
            href={jobUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: CYAN, wordBreak: "break-all", fontSize: 13 }}
          >
            {jobUrl}
          </a>
          {st.txHash && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <a
                href={`https://basescan.org/tx/${st.txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "rgba(255,255,255,0.6)" }}
              >
                view tx on basescan ↗
              </a>
            </div>
          )}
          <div style={{ marginTop: 18 }}>
            <Button variant="primary" onClick={() => mesh.leftclawReset()}>
              Post another
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Form / posting screen ----------------------------------------------
  const canDrive = Boolean(address);
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginBottom: 12, lineHeight: 1.5 }}>
          Hire the Leftclaw bots — post a job on-chain and a worker picks it up. You are the client (your wallet owns
          the job).
        </div>

        {/* Service picker */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {SERVICES.map(s => {
            const active = s.id === serviceId;
            return (
              <button
                key={s.id}
                disabled={posting}
                onClick={() => setServiceId(s.id)}
                style={{
                  flex: 1,
                  cursor: posting ? "default" : "pointer",
                  background: active ? "rgba(255,62,201,0.18)" : "rgba(255,255,255,0.04)",
                  border: active ? `1px solid ${ACCENT}` : "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  padding: "8px 6px",
                  color: active ? ACCENT : "rgba(255,255,255,0.8)",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{s.label}</div>
                <div style={{ fontSize: 11, opacity: 0.7 }}>${s.priceUsd}</div>
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 12 }}>{service.blurb}</div>

        {/* Description */}
        <textarea
          value={description}
          disabled={posting}
          onChange={e => setDescription(e.target.value)}
          placeholder={`Describe the ${service.label.toLowerCase()} job…`}
          rows={5}
          style={textarea}
        />
        <input
          value={context}
          disabled={posting}
          onChange={e => setContext(e.target.value)}
          placeholder="Optional context (links, addresses, constraints)…"
          style={input}
        />

        {/* Payment toggle */}
        <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
          {(["cv", "usdc"] as LeftclawPayment[]).map(p => {
            const active = p === payment;
            return (
              <button
                key={p}
                disabled={posting}
                onClick={() => setPayment(p)}
                style={{
                  flex: 1,
                  cursor: posting ? "default" : "pointer",
                  background: active ? "rgba(56,249,249,0.14)" : "rgba(255,255,255,0.04)",
                  border: active ? `1px solid ${CYAN}` : "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 6,
                  padding: "8px 6px",
                  color: active ? CYAN : "rgba(255,255,255,0.8)",
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 700 }}>{p === "cv" ? "Pay with CV" : "Pay with USDC"}</div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  {p === "cv" ? "burn larv.ai CV · needs ETH for gas" : "gasless x402"}
                </div>
              </button>
            );
          })}
        </div>

        {errored && st.error && (
          <div style={{ fontSize: 12, color: "#ff6b6b", marginBottom: 10, wordBreak: "break-word" }}>⚠ {st.error}</div>
        )}

        {posting ? (
          <div>
            <LoadingBar caption={st.step ?? "Posting…"} />
            {st.job?.startedBy && (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 6 }}>
                {st.job.startedBy} is posting…
              </div>
            )}
          </div>
        ) : canDrive ? (
          <Button variant="primary" onClick={post} disabled={!description.trim()} style={{ width: "100%" }}>
            Post {service.label} job · ${service.priceUsd}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => openConnectModal?.()} style={{ width: "100%" }}>
            Connect wallet to post
          </Button>
        )}
      </div>
    </div>
  );
};

const wrap: React.CSSProperties = {
  height: "100%",
  overflowY: "auto",
  background: PANEL_BG,
  padding: 14,
  color: "#fff",
  fontFamily: "var(--font-sans, system-ui)",
};

const card: React.CSSProperties = {
  border: BORDER,
  borderRadius: 8,
  padding: 16,
  background: "rgba(255,255,255,0.02)",
};

const textarea: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.35)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  color: "#fff",
  padding: 10,
  fontSize: 13,
  resize: "vertical",
  fontFamily: "inherit",
  marginBottom: 8,
};

const input: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.35)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  color: "#fff",
  padding: "8px 10px",
  fontSize: 12,
  fontFamily: "inherit",
};
