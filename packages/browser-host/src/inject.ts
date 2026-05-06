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
// We also pretend to be MetaMask via `isMetaMask: true` since plenty of
// dapps gate features on that flag.

export const PROVIDER_INJECT_SCRIPT = (
  impersonatedAddress: string,
  chainId: number,
): string => `
(() => {
  const IMPERSONATED = ${JSON.stringify(impersonatedAddress.toLowerCase())};
  const CHAIN_ID_HEX = ${JSON.stringify("0x" + chainId.toString(16))};

  // Methods we never sign for; we capture and emit calldata instead.
  const WRITE_METHODS = new Set([
    "eth_sendTransaction",
    "eth_signTransaction",
    "personal_sign",
    "eth_sign",
    "eth_signTypedData",
    "eth_signTypedData_v1",
    "eth_signTypedData_v3",
    "eth_signTypedData_v4",
  ]);

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
    wallet_switchEthereumChain: () => null,
    wallet_addEthereumChain: () => null,
    wallet_revokePermissions: () => null,
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
    if (typeof globalThis.__slopTxRequest === "function") {
      try {
        globalThis.__slopTxRequest(JSON.stringify(payload));
      } catch (e) { /* ignore */ }
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
    isMetaMask: true,
    isSlopImpersonator: true,
    chainId: CHAIN_ID_HEX,
    networkVersion: String(parseInt(CHAIN_ID_HEX, 16)),
    selectedAddress: IMPERSONATED,
    _events: listeners,

    request: async ({ method, params }) => {
      if (LOCAL_METHODS[method]) return LOCAL_METHODS[method](params);
      if (WRITE_METHODS.has(method)) {
        emitTxRequest({ method, params });
        // Mimic a user rejection — the dapp will surface this gracefully
        // rather than hang waiting for a signature.
        const err = new Error("Impersonator: tx captured, not signed");
        err.code = 4001;
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

  // EIP-6963 — modern wallet discovery. Dapps that don't poll window.ethereum
  // listen for these.
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
