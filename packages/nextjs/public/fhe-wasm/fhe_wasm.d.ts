/* tslint:disable */
/* eslint-disable */

export class ParamsHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class SecretKeyHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export function aggregate_public_key_contributions(contributions: Array<any>): Uint8Array;

export function combine_decryption_shares(shares: Array<any>, ciphertext: Uint8Array, threshold: number): Int32Array;

export function decrypt(params: ParamsHandle, sk: SecretKeyHandle, ct: Uint8Array): Int32Array;

export function derive_public_key(params: ParamsHandle, sk: SecretKeyHandle): Uint8Array;

export function dkg_round1(party_index: number, committee_size: number, threshold: number): any;

export function dkg_round2(party_index: number, round1_inputs: any): any;

export function encrypt_vector(params: ParamsHandle, pk: Uint8Array, plaintext: Int32Array): Uint8Array;

export function generate_secret_key(params: ParamsHandle): SecretKeyHandle;

export function homomorphic_add(params: ParamsHandle, a: Uint8Array, b: Uint8Array): Uint8Array;

export function init(): void;

export function load_params(): ParamsHandle;

export function partial_decrypt(secret_share: Uint8Array, ciphertext: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly aggregate_public_key_contributions: (a: any) => [number, number];
    readonly combine_decryption_shares: (a: any, b: number, c: number, d: number) => [number, number];
    readonly dkg_round1: (a: number, b: number, c: number) => any;
    readonly dkg_round2: (a: number, b: any) => any;
    readonly partial_decrypt: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbg_paramshandle_free: (a: number, b: number) => void;
    readonly __wbg_secretkeyhandle_free: (a: number, b: number) => void;
    readonly decrypt: (a: number, b: number, c: number, d: number) => [number, number];
    readonly derive_public_key: (a: number, b: number) => [number, number];
    readonly encrypt_vector: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly generate_secret_key: (a: number) => number;
    readonly homomorphic_add: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly load_params: () => number;
    readonly init: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
