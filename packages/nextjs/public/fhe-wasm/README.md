# fhe-wasm (vendored build)

Threshold BFV (trbfv) compiled to WebAssembly, from Auryn Macmillan's
[weft](https://github.com/auryn-macmillan/weft) repo
(`examples/weft-web/crates/fhe-wasm`), which vendors Gnosis Guild's
[fhe.rs](https://github.com/gnosisguild/fhe.rs) — the same FHE library
that powers [The Interfold](https://theinterfold.com) ciphernodes.

Built with `wasm-pack build --release --target web`. **LGPL-3.0-only**
(weft + fhe.rs). Kept as a separate dynamically-loaded module under
`public/` — served as static assets and imported at runtime by the
Voting Booth web worker (`voting.worker.js`), never bundled into the
app's own JS.

Exports used by the voting app: `load_params` (SECURE_THRESHOLD_8192
preset), `dkg_round1` / `dkg_round2` /
`aggregate_public_key_contributions` (threshold key ceremony),
`encrypt_vector` (ballot encryption), `homomorphic_add` (encrypted
tally), `partial_decrypt` / `combine_decryption_shares` (reveal).

To rebuild: clone weft, install rust + wasm-pack, apply `build.patch`
(sibling file — LGPL source-modification notice), then
`wasm-pack build --release --target web examples/weft-web/crates/fhe-wasm --out-dir pkg`
and copy `fhe_wasm.js`, `fhe_wasm_bg.wasm`, `fhe_wasm.d.ts` here.

`build.patch` contains two changes to the vendored source:
1. **wasm32 DKG fix** (`fhe/src/trbfv/shares.rs`): upstream compares
   `self.n < min_modulus.try_into().unwrap()` where the target is
   `usize` — 32-bit on wasm32, so any real BFV modulus (~50-60 bits)
   makes the conversion panic and `dkg_round1` dies with `unreachable`.
   Patched to compare in u64. Native 64-bit builds never hit this,
   which is why weft's own cargo tests pass unpatched. Worth
   upstreaming to gnosisguild/fhe.rs.
2. **console_error_panic_hook** wired into `init()` so future wasm
   panics surface real messages in the browser console instead of
   bare `RuntimeError: unreachable`.

Re-vendoring status (checked 2026-07-03): upstream fhe.rs v0.2.2 fixed
the DKG bug (proper error instead of the panicking assert), but
swapping it in is NOT a drop-in — the API moved under weft's crate
(rand 0.8→0.9 trait bounds, `fhe::proto::trbfv` serializers relocated,
`ShareManager::new` returns `Result`, `ctx_at_level` gone) and the
crates now use cargo workspace-inheritance (breaks when vendored into
another workspace). Porting weft's fhe-wasm to the new API is upstream
(weft) work — tracked as weft issue #1. Until then this patched build
stands; it is semantically identical to upstream's fix.
