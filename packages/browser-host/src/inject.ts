// Provider injection script — stringified and run as `evaluateOnNewDocument`
// before any of the dapp's own scripts. Defines `window.ethereum` (and the
// EIP-6963 announcement) so the dapp sees vitalik.eth as the connected
// wallet.
//
// Read calls (eth_call, eth_getBalance, etc.) are forwarded to the host's
// /rpc endpoint, which proxies to Alchemy server-side so we don't leak the
// API key into the page. Write calls (eth_sendTransaction, personal_sign,
// eth_signTypedData_v*) never sign — they fire the host-exposed binding
// `__slopTxRequest` so the host can broadcast the calldata to all peers
// and reject the request from the dapp's perspective.
//
// Wallet identity: we used to set `isMetaMask: true` so dapps gating on
// it would treat us as a recognized wallet. We dropped that flag because
// some Uniswap code paths assume MetaMask supports Permit2 (gasless
// EIP-712 approval) unconditionally — a multisig can't sign typed data,
// so we want to *not* be MetaMask. We also DO NOT claim Safe identity
// (rdns=app.safe.global) — Uniswap responds to that by booting its Safe
// Apps SDK path which expects parent-iframe postMessage and breaks the
// connection entirely. We identify as our own provider via EIP-6963 and
// let Uniswap discover Permit2 doesn't work the hard way (it will retry
// the signature, fail, and the user has to click "approve manually" or
// hit Swap again — second attempt always succeeds because the dapp
// caches the rejection and skips the permit path).

export const PROVIDER_INJECT_SCRIPT = (
  impersonatedAddress: string,
  chainId: number,
  supportedChainIds: number[],
): string => `
(() => {
  const IMPERSONATED = ${JSON.stringify(impersonatedAddress.toLowerCase())};
  const CHAIN_ID_HEX = ${JSON.stringify("0x" + chainId.toString(16))};
  // Mirror of the host's SUPPORTED_CHAINS so we can reject unknown
  // chains synchronously per EIP-3326 (error code 4902) — CDP bindings
  // are fire-and-forget, so the page can't await a host validation.
  const SUPPORTED_CHAIN_IDS_HEX = ${JSON.stringify(supportedChainIds.map(c => "0x" + c.toString(16).toLowerCase()))};

  // Transactions: capture calldata, then "user rejected" (4001) so the
  // dapp surfaces gracefully. The captured tx goes into the multisig's
  // pending queue, where the real signers ratify and broadcast it.
  const TX_METHODS = new Set([
    "eth_sendTransaction",
  ]);
  // Signing methods: a multisig contract has no private key — it can't
  // sign anything off-chain. If we reject with 4001 (user rejected),
  // dapps like Uniswap interpret that as "user clicked cancel" and
  // retry the Permit2 signature several times before eventually
  // falling back to legacy approve+swap. 4200 (Unsupported Method, per
  // EIP-1193) tells the dapp "this provider literally cannot do this"
  // so it falls back on the FIRST attempt — turning the Permit2 dance
  // into two clean eth_sendTransactions that the multisig CAN queue.
  // We still emitTxRequest so the local tx panel shows what was
  // attempted (useful for debugging and so peers can see signature
  // attempts even though we won't sign them).
  const SIGN_METHODS = new Set([
    "eth_signTransaction",
    "personal_sign",
    "eth_sign",
    "eth_signTypedData",
    "eth_signTypedData_v1",
    "eth_signTypedData_v3",
    "eth_signTypedData_v4",
  ]);

  // EIP-3326: forward the requested chainId to the host via the
  // __slopChainSwitch binding. The host destroys+recreates this tab on
  // the new chain — after which the fresh inject reports the new
  // CHAIN_ID_HEX and the dapp re-initializes naturally.
  function requestChainSwitch(params) {
    const target = params && params[0] && params[0].chainId;
    if (typeof target !== "string") {
      const err = new Error("wallet_switchEthereumChain: missing chainId");
      err.code = -32602;
      throw err;
    }
    const targetNum = parseInt(target, 16);
    if (!Number.isFinite(targetNum)) {
      const err = new Error("wallet_switchEthereumChain: invalid chainId");
      err.code = -32602;
      throw err;
    }
    // EIP-3326 4902: chain not added to the wallet. We validate against
    // our pre-baked supported list (CDP bindings can't return a value,
    // so we can't ask the host synchronously) — keeping this list in
    // sync with the host's SUPPORTED_CHAINS is the price of admission.
    const targetHex = "0x" + targetNum.toString(16).toLowerCase();
    if (!SUPPORTED_CHAIN_IDS_HEX.includes(targetHex)) {
      const err = new Error("Unrecognized chain ID — call wallet_addEthereumChain first");
      err.code = 4902;
      throw err;
    }
    // No-op if the page is already on the requested chain. Spec says
    // return null in that case — same as a successful switch.
    if (targetHex === CHAIN_ID_HEX) return null;
    if (typeof globalThis.__slopChainSwitch === "function") {
      try { globalThis.__slopChainSwitch(String(targetNum)); } catch (e) { /* ignore */ }
    }
    // Emit chainChanged for any listeners attached before the imminent
    // page reload. The reload itself will destroy these listeners, but
    // firing now means a synchronous dapp ("got success → wait for
    // chainChanged → update UI") gets the update before its context
    // dies. After the reload, the dapp re-initializes against the
    // fresh provider with the new CHAIN_ID_HEX.
    setTimeout(() => emit("chainChanged", targetHex), 0);
    return null;
  }

  // Methods served locally without round-tripping to the upstream.
  const LOCAL_METHODS = {
    eth_accounts: () => [IMPERSONATED],
    eth_requestAccounts: () => [IMPERSONATED],
    eth_chainId: () => CHAIN_ID_HEX,
    net_version: () => String(parseInt(CHAIN_ID_HEX, 16)),
    wallet_getPermissions: () => [{
      parentCapability: "eth_accounts",
      caveats: [{ type: "restrictReturnedAccounts", value: [IMPERSONATED] }],
    }],
    wallet_requestPermissions: () => [{
      parentCapability: "eth_accounts",
      caveats: [{ type: "restrictReturnedAccounts", value: [IMPERSONATED] }],
    }],
    wallet_switchEthereumChain: requestChainSwitch,
    // EIP-3085: dapps "add" a chain before switching to it. We don't
    // dynamically learn new chains (only the host's SUPPORTED_CHAINS),
    // so route this the same way — if the chainId is one we know, the
    // host will accept the recreate; otherwise it logs + ignores and
    // the dapp's follow-up switch will hit the unsupported path.
    wallet_addEthereumChain: requestChainSwitch,
    wallet_revokePermissions: () => null,
    // EIP-5792 capability discovery. Advertise atomic batching as
    // SUPPORTED per chain — that's the single signal Uniswap's swap
    // saga (apps/web/src/state/sagas/transactions/swapSaga.ts) reads
    // to decide whether to bundle approve + Permit2.permit + swap
    // into one wallet_sendCalls batch instead of asking for the
    // off-chain EIP-712 Permit2 signature we can't produce. Without
    // this Uniswap's TransactionStepType.Permit2Signature branch
    // runs, fails on our multisig, and shows "Permit approval
    // failed." With this, the whole flow becomes a single batched tx
    // that maps 1:1 onto the multisig's execBatchTransaction.
    wallet_getCapabilities: () => {
      const out = {};
      for (const hex of SUPPORTED_CHAIN_IDS_HEX) {
        out[hex] = { atomic: { status: "supported" } };
      }
      return out;
    },
    // EIP-5792 wallet_sendCalls. params[0] = {
    //   version, chainId, from, calls: [{to, value, data}], capabilities?
    // }
    // Capture the batch through the same __slopTxRequest binding as
    // eth_sendTransaction — SharedBrowser routes it into the multisig
    // queue as a single execBatchTransaction propose. We MUST
    // resolve successfully (not throw) — Uniswap fails the whole
    // swap if sendCalls rejects. The batch id is a random 32-byte
    // hex shared with the host through the emit payload so it can
    // bookkeep status against it (see wallet_getCallsStatus below).
    wallet_sendCalls: (params) => {
      // Stable-ish random id — crypto.getRandomValues is available
      // in every Chromium context the host launches. Falls back to
      // Math.random for old browsers / SES locked-down realms.
      var id = "0x";
      try {
        var bytes = new Uint8Array(32);
        (globalThis.crypto || globalThis.msCrypto).getRandomValues(bytes);
        for (var i = 0; i < bytes.length; i++) id += bytes[i].toString(16).padStart(2, "0");
      } catch (e) {
        for (var j = 0; j < 64; j++) id += Math.floor(Math.random() * 16).toString(16);
      }
      // Emit WITH the batchId so SharedBrowser can wire its eventual
      // receipt back into the host's per-batch status map.
      emitTxRequest({ method: "wallet_sendCalls", params: params, batchId: id });
      // v1.0 callers expect a bare id string; v2.0.0 expects {id}.
      // Default to v2 since that's what modern dapps (Uniswap
      // included) use.
      var reqVersion = params && params[0] && params[0].version;
      if (reqVersion === "1.0") return id;
      return { id: id };
    },
    // EIP-5792 wallet_getCallsStatus. Uniswap polls this until the
    // batch resolves; we ask the host (which knows the
    // multisig-execution outcome via SharedBrowser) for the current
    // status and forward it. The host responds with PENDING (100)
    // until the multisig signers ratify + the on-chain
    // execBatchTransaction lands; then it flips to SUCCESS (200)
    // with a receipt or FAILED (500).
    //
    // This is async — request() awaits it.
    wallet_getCallsStatus: async (params) => {
      var id = params && params[0];
      if (typeof id !== "string") {
        return {
          version: "2.0.0", id: "0x", chainId: CHAIN_ID_HEX,
          atomic: true, status: 100, receipts: [],
        };
      }
      try {
        var res = await fetch("/__slop_batch_status?id=" + encodeURIComponent(id));
        if (res.ok) {
          var json = await res.json();
          if (json && typeof json === "object") return json;
        }
      } catch (e) {
        /* fall through to PENDING */
      }
      return {
        version: "2.0.0", id: id, chainId: CHAIN_ID_HEX,
        atomic: true, status: 100, receipts: [],
      };
    },
    // EIP-5792 wallet_showCallsStatus — a UX nudge: "open the
    // wallet's batch-status UI". We don't have a separate UI for
    // batch txs (they live in the same Transactions tab as single
    // txs), so this is a no-op.
    wallet_showCallsStatus: () => null,
  };

  let nextId = 1;

  async function rpcCall(method, params) {
    const res = await fetch("/__slop_rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params || [] }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  }

  function emitTxRequest(payload) {
    // bindings are exposed by the host via Runtime.addBinding; the page
    // calls them like a normal global function and the host receives a
    // Runtime.bindingCalled CDP event with the JSON payload.
    var hasBinding = typeof globalThis.__slopTxRequest === "function";
    // Surface via console.warn so the host's page.on("console") pipe picks
    // it up (only error/warn levels are forwarded). [SLOP-TX-DEBUG] is
    // grep-able if we want to remove this later.
    try { console.warn("[SLOP-TX-DEBUG] inject.emitTxRequest", { method: payload && payload.method, hasBinding: hasBinding }); } catch (e) { /* ignore */ }
    if (hasBinding) {
      try {
        globalThis.__slopTxRequest(JSON.stringify(payload));
      } catch (e) {
        try { console.warn("[SLOP-TX-DEBUG] inject binding-call threw", String(e)); } catch (_) { /* ignore */ }
      }
    }
  }

  const listeners = new Map();
  function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { /* ignore */ }
    }
  }

  const provider = {
    // Identity flags. We DON'T claim isSafe/rdns=app.safe.global —
    // Uniswap responds by booting up its Safe Apps SDK path, which
    // expects parent-iframe postMessage communication (we're not a
    // Safe iframe) and just fails to connect. Dropping isMetaMask is
    // still worth doing — it avoids MetaMask-specific Permit2
    // assumptions — but we identify as our own provider.
    isSlopImpersonator: true,
    chainId: CHAIN_ID_HEX,
    networkVersion: String(parseInt(CHAIN_ID_HEX, 16)),
    selectedAddress: IMPERSONATED,
    _events: listeners,

    request: async ({ method, params }) => {
      if (LOCAL_METHODS[method]) return LOCAL_METHODS[method](params);
      if (TX_METHODS.has(method)) {
        emitTxRequest({ method, params });
        // Mimic a user rejection (4001) — the dapp surfaces "tx cancelled"
        // gracefully. The captured calldata is already on its way to the
        // multisig queue via the host.
        const err = new Error("Impersonator: tx captured, not signed");
        err.code = 4001;
        throw err;
      }
      if (SIGN_METHODS.has(method)) {
        emitTxRequest({ method, params });
        // 4200 Unsupported Method (EIP-1193). Tells the dapp the provider
        // doesn't support off-chain signing AT ALL, so it falls back to
        // legacy on-chain approve flows on the first try instead of
        // retrying the same signature N times before giving up.
        const err = new Error("Impersonator: this wallet cannot sign off-chain (multisig contract)");
        err.code = 4200;
        throw err;
      }
      // Reads — forward to the upstream RPC.
      return rpcCall(method, params);
    },

    // Legacy callback-style sendAsync (web3.js, ethers v4, etc.)
    sendAsync(payload, cb) {
      Promise.resolve(this.request(payload))
        .then(result => cb(null, { jsonrpc: "2.0", id: payload.id, result }))
        .catch(error => cb(error));
    },

    // Even older synchronous send (truffle-contract et al.)
    send(method, params) {
      if (typeof method === "string") return this.request({ method, params });
      // Object form, callback at params position
      if (typeof params === "function") return this.sendAsync(method, params);
      return this.request(method);
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return provider;
    },
    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
    addListener(event, fn) { return provider.on(event, fn); },
    off(event, fn) { return provider.removeListener(event, fn); },
    once(event, fn) {
      const wrap = (...a) => { provider.removeListener(event, wrap); fn(...a); };
      return provider.on(event, wrap);
    },
    emit,
  };

  // Fire the standard "connected" event a tick later so listeners attached
  // after script execution still receive it.
  setTimeout(() => emit("connect", { chainId: CHAIN_ID_HEX }), 0);

  Object.defineProperty(window, "ethereum", {
    value: provider,
    writable: false,
    configurable: false,
  });

  // EIP-6963 — modern wallet discovery. Dapps that don't poll
  // window.ethereum listen for these. Identify as ourselves —
  // claiming Safe's rdns triggers Uniswap's Safe Apps SDK path which
  // breaks the connection entirely (it expects an iframe parent that
  // doesn't exist here).
  const info = {
    uuid: "00000000-0000-4000-8000-000000000001",
    name: "Slop Impersonator",
    icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='%23ff3ec9'/></svg>",
    rdns: "computer.slop.impersonator",
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: Object.freeze({ info, provider }),
  }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
`;
