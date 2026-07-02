// Voting Booth crypto worker. Loads the vendored threshold-BFV wasm
// (see README.md in this directory) and exposes it over a tiny
// {id, op, args} → {id, ok, result} postMessage protocol. All BFV ops
// take hundreds of ms — keeping them off the main thread keeps the
// desktop responsive while a ballot encrypts.
//
// Runs as a module worker: new Worker("/fhe-wasm/voting.worker.js", { type: "module" })

import init, * as fhe from "/fhe-wasm/fhe_wasm.js";

const ready = init("/fhe-wasm/fhe_wasm_bg.wasm").then(() => fhe.load_params());

function toU8(v) {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

const ops = {
  // Key ceremony: simulate all committee parties' DKG rounds in this
  // worker and hand back the joint public key + one secret share per
  // party. The shares never leave the creator's browser.
  async dkg(params, { committeeSize, threshold }) {
    // wasm threshold arg is the polynomial degree = t - 1
    const round1 = [];
    for (let i = 1; i <= committeeSize; i++) {
      round1.push(fhe.dkg_round1(i, committeeSize, threshold - 1));
    }
    const round2 = [];
    for (let i = 1; i <= committeeSize; i++) {
      round2.push(fhe.dkg_round2(i, round1));
    }
    const publicKey = fhe.aggregate_public_key_contributions(
      round2.map(out => toU8(out.public_key_contribution)),
    );
    return {
      publicKey,
      shares: round2.map(out => ({
        partyIndex: out.party_index,
        bytes: toU8(out.secret_share),
      })),
    };
  },

  async encrypt(params, { publicKey, plaintext }) {
    return fhe.encrypt_vector(params, toU8(publicKey), Int32Array.from(plaintext));
  },

  async aggregate(params, { ciphertexts }) {
    if (!ciphertexts.length) throw new Error("no ciphertexts");
    let acc = toU8(ciphertexts[0]);
    for (const ct of ciphertexts.slice(1)) {
      acc = fhe.homomorphic_add(params, acc, toU8(ct));
    }
    return acc;
  },

  async partialDecrypt(params, { share, ciphertext }) {
    return fhe.partial_decrypt(toU8(share), toU8(ciphertext));
  },

  async combine(params, { shares, ciphertext }) {
    // The wasm's threshold convention is the DKG polynomial degree (t - 1),
    // not the human "3 of 5". Each decryption-share bundle records the value
    // it was generated with — decode it from the first share (same as
    // weft-web) instead of trusting the caller to know the convention.
    const first = JSON.parse(new TextDecoder().decode(toU8(shares[0])));
    if (!Number.isInteger(first.threshold) || first.threshold < 0) {
      throw new Error("share bundle missing threshold metadata");
    }
    const plain = fhe.combine_decryption_shares(
      shares.map(toU8),
      toU8(ciphertext),
      first.threshold,
    );
    return Int32Array.from(plain);
  },
};

self.onmessage = async ev => {
  const { id, op, args } = ev.data || {};
  if (!id || !ops[op]) return;
  try {
    const params = await ready;
    const result = await ops[op](params, args || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
