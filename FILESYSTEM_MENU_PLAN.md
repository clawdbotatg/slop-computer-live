# Co-op OS Plan — Menus, Filesystem, Apps

Extends the existing live desktop (`packages/nextjs/app/desktop/page.tsx`,
`packages/nextjs/hooks/usePeerMesh.ts`, `packages/relay/src/desktop.ts`,
`packages/relay/src/index.ts`) to make slop-computer-live a real shared OS that
all connected peers can drive together — not just a webcam grid.

## Guiding principles

These are the rules already in force in the codebase. New features must fit
them or have a strong reason not to.

1. **Relay is the linearization point.** Every shared mutation goes
   client → relay → broadcast. No client-to-client state — the WS round-trip
   is the source-of-truth ordering. Cursor positions, publications, and slot
   positions all already follow this.
2. **Last-writer-wins, per object.** If peer A and peer B mutate the same
   slot/node/window concurrently, the relay's arrival order decides; both
   then converge after the broadcast. We do **not** introduce CRDTs, vector
   clocks, or version numbers in v1 — `applySlotUpdate` is the template.
3. **Optimistic local updates** on the client to keep `react-rnd`-style
   controlled components from snapping back during drag. The relay echo
   later confirms (or overwrites with someone else's intent).
4. **Authenticated peers are equal.** We already let any guest move any
   slot (see commit `8e03eb2`). Apply the same rule to menus and FS for v1.
   Host-only restrictions can be added later via `requireHost()`-style
   guards if abuse becomes real.
5. **In-memory on the relay** for new state in v1. Slot positions persist
   to disk because layout-after-restart matters; menu state and the FS
   reset on restart in v1. Persistence is a follow-up, not a v1 requirement.
6. **One relay module per concern.** `desktop.ts` already isolates
   publications + slots. Add `menu.ts`, `fs.ts`, `appWindows.ts` in the
   same shape — pure functions, exported state queries, no WS coupling.
   Wiring lives in `index.ts`.

---

## 1. Co-op Menu System

### Behavior

Mac OS 9-style menu bar already renders via `MenuBar.tsx`. Today the dropdown
items are inert text. We make them real:

- Click a menu title (`File`, `Edit`, `Window`, `Help`, …) → dropdown opens
  on **every** peer's screen, not just the clicker's.
- Click an item → the action runs (open app, create folder, etc.). Some
  actions are **shared** (open an app, create a folder), some are
  **local-only** (sign out, "About this Mac" if it's a personal modal).
- Click outside / press Escape / pick an item → menu closes everywhere.

### Ownership model

**Last-writer-wins, no special "owner".** A single shared field on the
relay records "which menu is currently open and who opened it":

```ts
type OpenMenu = { menuId: string; openedBy: string /* peerId */ } | null;
```

If peer A opens `File` and peer B then opens `Edit`, B's message arrives
later, the relay broadcasts the new state, A's UI jumps from the File
dropdown to the Edit dropdown. This is jarring but honest — it mirrors how
slot-drag already works when two peers race a window. Alternative
("host-only menu state") was considered and rejected because the user
explicitly asked for any co-op player to be able to drive menus.

A small UX softener: render a tiny avatar/handle of `openedBy` next to the
open dropdown so it's obvious *whose* click is steering. Same as a shared
cursor label — readers understand the friction once they see attribution.

### Menu definitions

Static for v1, defined in TS (not in the FS — keeps the bootstrap simple):

```ts
type MenuItem =
  | { kind: "action"; id: string; label: string; shortcut?: string }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; items: MenuItem[] };

type Menu = { id: string; label: string; items: MenuItem[] };

const MENUS: Menu[] = [
  { id: "apple",  label: "🍎",     items: [
    { kind: "action", id: "about", label: "About this Mac" },
  ]},
  { id: "file",   label: "File",   items: [
    { kind: "action", id: "new-folder", label: "New Folder",  shortcut: "⌘N" },
    { kind: "action", id: "new-file",   label: "New File",    shortcut: "⇧⌘N" },
  ]},
  { id: "edit",   label: "Edit",   items: [
    { kind: "action", id: "rename",     label: "Rename"  },
    { kind: "action", id: "delete",     label: "Delete"  },
  ]},
  { id: "window", label: "Window", items: [
    /* dynamically populated from open app windows */
  ]},
  { id: "wallet", label: "Wallet", items: [
    { kind: "action", id: "sign-out",   label: "Sign out" },
  ]},
];
```

Action handlers are dispatched by `id`. A handler decides whether the
effect is local (`sign-out`) or shared (`new-folder` → emits an FS event).

### Wire protocol additions

```
Client → server:
  { type: "menu_open",  menuId: string }
  { type: "menu_close" }                          // explicit close

Server → client:
  { type: "menu_state", openMenu: OpenMenu }      // null when closed
```

The relay also auto-closes the menu when `openedBy` disconnects (avoids a
ghost dropdown stuck open after a peer leaves with their menu showing).

### Relay module: `packages/relay/src/menu.ts`

```ts
let openMenu: { menuId: string; openedBy: string } | null = null;

export function getOpenMenu() { return openMenu; }
export function setOpenMenu(next: { menuId: string; openedBy: string } | null) {
  openMenu = next;
}
export function clearMenuIfOpenedBy(peerId: string): boolean {
  if (openMenu?.openedBy === peerId) { openMenu = null; return true; }
  return false;
}
```

Wired into `index.ts`'s WS handler (cases `menu_open`, `menu_close`) and
the `socket.on("close")` cleanup. Initial value piggy-backs on the
existing `hello` message so a late joiner sees an already-open menu.

### Client integration

`MenuBar.tsx` becomes a controlled component:

- Add prop `openMenu: OpenMenu` and callbacks `onOpenMenu(menuId)`,
  `onCloseMenu()`. Page wires these to `mesh.menuOpen` /
  `mesh.setMenuOpen`. No more local `useState` for which menu is open.
- Dropdown rendered as an absolutely-positioned `<ul>` anchored to the
  open menu's `<span>` (use a ref-keyed lookup or render the dropdown
  inline beneath the bar).
- Click outside: `useEffect` adds a single `document.mousedown` listener
  while a menu is open, sends `menu_close` on outside click.
- Press Escape: same — sends `menu_close`.

---

## 2. Co-op Filesystem

### Data model

Flat map of nodes keyed by uuid, with `parentId` pointers. Trees built
client-side by walking children. Flat-with-pointers serialises cleanly
over WS without recursion limits.

```ts
export type FsNodeId = string; // uuid

export type FsFileContent =
  | { type: "text"; text: string }
  | { type: "url";  url: string }                                  // generic external link
  | { type: "app";  url: string; icon?: string; defaultSize?: { width: number; height: number } };

export type FsNode =
  | { kind: "folder"; id: FsNodeId; parentId: FsNodeId | null; name: string; createdAt: number; updatedAt: number; createdBy: string /* peerId-or-ownerKey */ }
  | { kind: "file";   id: FsNodeId; parentId: FsNodeId | null; name: string; createdAt: number; updatedAt: number; createdBy: string; content: FsFileContent };
```

Constraints:

- **Root** is a single folder with `id = "root"`, `parentId = null`. Always
  exists, cannot be renamed or deleted.
- **Name uniqueness within a parent.** Enforced server-side: a `create` or
  `rename` that would collide is rejected with an error reply (not
  silently de-duped — silent de-dup makes "I created a file but it's gone"
  bugs). Client UI handles by suggesting `Foo (2)`.
- **Cycle prevention** for `move`: server walks ancestors of the new
  parent; if `targetId` appears, reject.
- No file-size limit in v1, but enforce a soft cap on `content.text`
  (e.g. 64 KiB) to keep the relay process well-behaved.

### Seeded tree

On relay boot, populate:

```
root/
├─ Applications/
│  ├─ Browser.app           { kind: "app", url: "https://example.com",       icon: "globe" }
│  ├─ Frontpage.app         { kind: "app", url: "https://slop.computer",     icon: "tv" }
│  └─ Etherscan.app         { kind: "app", url: "https://etherscan.io",      icon: "scan" }
├─ Desktop/                 (empty — peers can drop shortcuts here)
└─ Notes/
   └─ Welcome.txt           { kind: "text", text: "Welcome to slop-computer-live!" }
```

This gives the UI something to render on day one. Re-seeded on every
relay restart (in-memory v1).

### Wire protocol additions

```
Client → server:
  { type: "fs_create",         parentId, kind: "folder"|"file", name, content? }
  { type: "fs_rename",         id, name }
  { type: "fs_delete",         id }                                   // recursive for folders
  { type: "fs_move",           id, newParentId }
  { type: "fs_update_content", id, content }                          // file only

Server → client:
  { type: "fs_snapshot", nodes: FsNode[] }                            // sent in `hello`
  { type: "fs_node",     node: FsNode }                               // single create/update
  { type: "fs_deleted",  ids: FsNodeId[] }                            // delete; ids = node + descendants
  { type: "fs_error",    op: string, reason: string, attemptedId?: string }
```

`fs_snapshot` rides on the existing `hello` message rather than as a
separate event so a late joiner has fs state at the same instant it has
peer state. Same pattern as `publications` and `slots` today.

### Relay module: `packages/relay/src/fs.ts`

```ts
const nodes = new Map<FsNodeId, FsNode>();

export function listNodes(): FsNode[];
export function createNode(input: { parentId, kind, name, content?, createdBy }):
  { ok: true; node: FsNode } | { ok: false; reason: string };
export function renameNode(id, name):           Result;
export function deleteNode(id): { ok: true; deletedIds: FsNodeId[] } | { ok: false; reason: string };
export function moveNode(id, newParentId):      Result;
export function updateContent(id, content):     Result;
```

All mutations bump `updatedAt`. Collision/cycle/missing-parent checks
return structured errors so the WS handler can `send(socket, fs_error)`
to the originating peer only — broadcasting a failure to everyone would
be noisy.

### React state shape

Add to `usePeerMesh`'s return:

```ts
fs: Record<FsNodeId, FsNode>;
fsCreate: (input: { parentId; kind; name; content? }) => void;
fsRename: (id: FsNodeId, name: string) => void;
fsDelete: (id: FsNodeId) => void;
fsMove:   (id: FsNodeId, newParentId: FsNodeId) => void;
fsUpdate: (id: FsNodeId, content: FsFileContent) => void;
```

Optimistic updates: on `fsRename`/`fsUpdate`, mutate local map immediately,
send WS message. On `fs_error`, revert the affected id to the last known
server value (re-fetch via a `fs_get` request — or simpler, just request
an `fs_snapshot` resync since it's small in v1).

For `fsCreate`, **don't** optimistically insert a placeholder — the server
mints the id, so the local insert happens on `fs_node` echo. The new-file
dialog can show a brief "creating…" spinner; usually <50 ms round-trip.

### UI surfaces

Two new components, both rendered as standard `<Window>`s — they
participate in the existing slot system for position/size:

- `<DesktopIcons>` — full-screen drop layer behind the windows that
  renders icons for everything in `Desktop/`. Double-click an `.app` →
  `appOpen`; double-click a folder → opens a `<Finder>` window for it.
- `<Finder>` — a window listing children of a folder; supports
  rename / delete / drag-to-move / new folder via right-click menu.
  Multiple Finder windows can coexist (one per folder).

Both can be deferred — the menu bar's `New Folder` action is enough for
day one to prove the FS works end-to-end.

---

## 3. Apps as iframes

### What an app is

An "app" is a file in the FS with `content.type === "app"`. Opening it
spawns a draggable window whose body is an `<iframe src={content.url}>`.

There's no separate "installed apps" registry — `/Applications/*.app` is
just a UI convention. Anything in the FS with the right content type is
launchable from anywhere, including an inline `Open URL…` menu action.

### Open windows model

Open app windows are tracked separately from FS files. The FS holds the
*definition*; `appWindows` holds the live *instances*.

```ts
export type AppWindowId = string; // uuid, distinct from FsNodeId

export type AppWindow = {
  id: AppWindowId;
  fileId: FsNodeId | null;     // source file; null if opened from an inline url
  url: string;                 // snapshotted at open time so renames/deletes don't affect live windows
  title: string;               // snapshotted from file name
  icon?: string;
  openedBy: string;            // peerId (informational)
  openedAt: number;
};
```

Position / size / z-index live in the existing `slots` map under id
`app-${windowId}`. This deliberately reuses the slot system — `<Window>`
already plumbs `onMove`/`onResize`/`onFocus` into `mesh.updateSlot`,
which already does relay broadcast + persistence. No new layout code.

### Wire protocol additions

```
Client → server:
  { type: "app_open",  fileId?: FsNodeId, url?: string, title?: string }
                                                         // either fileId OR url+title
  { type: "app_close", windowId: AppWindowId }

Server → client:
  { type: "app_snapshot", windows: AppWindow[] }         // in `hello`
  { type: "app_opened",   window: AppWindow }
  { type: "app_closed",   windowId: AppWindowId }
```

Slot updates for app windows reuse the existing `slot_update` / `slot`
messages — the relay doesn't need to know `app-*` slot ids are special.

### Z-fighting & default position

The classic "two peers double-click Browser.app at the same time" case:

- **Distinct ids.** Each `app_open` mints a new uuid server-side, so two
  concurrent opens always become two windows. **No** dedup-by-fileId —
  multiple Browser windows is a feature.
- **Server-assigned z.** When the relay processes `app_open`, it computes
  `z = max(slots.z) + 1` and writes the slot before broadcasting. This
  also applies on focus: change `focusSlot` so the client sends
  `slot_update { id, z: undefined }` and the relay assigns the next z.
  This is a small protocol change (`z = "bring-to-front"` sentinel) but
  it eliminates the "two peers click two windows simultaneously and both
  end up at z=42" race.
- **Cascade offset.** Default position is `(80 + n*30, 280 + n*30)` where
  `n = count of currently-open app windows`, computed server-side. Two
  concurrent opens get `n` and `n+1`, not the same position.

### Sandboxing

Default `<iframe>` attributes:

```html
<iframe
  src={url}
  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
  referrerpolicy="no-referrer"
  allow=""
/>
```

Notes:

- **No `allow-same-origin`.** Without it, the iframe's `document.origin`
  is `null` so it cannot touch its own real origin's cookies/localStorage
  even if it wanted to. This breaks some apps that need to log in. For v1,
  document the limitation; add a per-app opt-in flag later
  (`content.allowSameOrigin: boolean`) reviewed by the host before merge.
- **No `allow-top-navigation`.** A malicious app must not be able to
  redirect the desktop tab away from `live.slop.computer`.
- **No `allow-forms`.** Same reason — keeps phishing in our chrome
  out of scope. Re-enable per-app once we have a manifest review story.
- **`allow=""`** disables all Permissions-Policy features (camera, mic,
  geolocation). The desktop already has the user's camera; an app must
  not be able to silently grab a second one.
- X-Frame-Options / CSP frame-ancestors of the target site is the other
  side of this — many sites refuse to be framed. UI should detect a load
  failure (timeout + empty body) and show "this site refuses to be
  embedded" rather than a silent blank window.

### Lifecycle

- Open: any authenticated peer sends `app_open`. Relay creates the
  `AppWindow` + the initial slot, broadcasts `app_opened` and `slot`.
- Move/resize: existing slot pipeline.
- Close: any authenticated peer sends `app_close { windowId }`. Relay
  removes the window AND the corresponding slot (`app-${windowId}`),
  broadcasts `app_closed`. We deliberately allow any peer to close any
  app window for v1 — same egalitarian model as moving slots.
- Disconnect: opened-by-peer leaving does **not** auto-close their app
  windows. Apps outlive their opener (a guest may open a window, leave,
  and the host wants the window to stay). Different rule from menu state
  on purpose — menus are ephemeral UI affordances; app windows are
  persistent shared content.

---

## 4. Browser app (Mac OS 9 chrome + @impersonator/iframe)

The generic iframe app from §3 covers public sites that allow framing.
But the headline use case is **visiting crypto dapps and signing
transactions on stream**. Plain iframes can't do that — the dapp's
WalletConnect / injected provider has no path to our shared wallet.

`@impersonator/iframe` solves exactly this: it injects a provider into
the iframed dapp that intercepts `eth_sendTransaction`,
`personal_sign`, `eth_signTypedData_v4`, and `wallet_switchEthereumChain`,
and bubbles them up to JS callbacks in the parent. We then route those
into our shared wallet flow (§5) for co-op signing.

So `Browser.app` is a **distinct app type**, not just a URL iframe.

### Package shape

```
@impersonator/iframe (v0.4.1)

<ImpersonatorIframeProvider
  address?:  string                       // address being impersonated (the wallet we route through)
  appUrl?:   string
  rpcUrl?:   string
  sendTransaction?:    (tx: Transaction) => Promise<string>          // returns tx hash
  signMessage?:        (message: string) => Promise<string>          // returns sig
  signTypedData?:      (typedData: EIP712TypedData) => Promise<string>
  onChainSwitchRequest?: (chainId: number) => void
>
  <ImpersonatorIframe
    width|height: number|string
    src:     string
    address: string
    rpcUrl:  string
    onLoad?: () => void
  />
</ImpersonatorIframeProvider>

useImpersonatorIframe() → { iframeRef, isReady, setAddress, setAppUrl, setRpcUrl }
```

Provider lives **once** at the desktop root so all Browser windows share
the same callbacks. Each Browser window mounts its own
`<ImpersonatorIframe>`. Switching the impersonated address is
per-provider (not per-iframe), so if we want different windows pointing
at different wallets we either (a) mount one provider per window, or (b)
multiplex via `setAddress` before each call. **Choose (a)** — simpler,
and providers are cheap. Each `<BrowserWindow>` wraps its own provider.

### FS representation

A new file content type:

```ts
type FsFileContent =
  | { type: "text"; text: string }
  | { type: "url";  url: string }
  | { type: "app";  url: string; icon?: string; defaultSize?: { width: number; height: number } }
  | { type: "browser"; icon?: string };  // ← new — Browser.app
```

Seed `/Applications/Browser.app` with `{ type: "browser", icon: "🌐" }`
on relay boot. Double-clicking it spawns a window of kind `"browser"`
(distinct from `"app"`).

### Window state additions

Extend `AppWindow` with a discriminated `kind`:

```ts
type AppWindow =
  | { kind: "app";     id; fileId; url; title; icon?; openedBy; openedAt }
  | { kind: "browser"; id; fileId; title; icon?; openedBy; openedAt;
      currentUrl: string;            // shared URL bar — synced across peers
      walletId: WalletId | null;     // which shared wallet (§5) is bound to this window
      chainId: number;               // current chain (for wallet_switchEthereumChain)
    };
```

`currentUrl`, `walletId`, and `chainId` are **shared** — every peer sees
the same dapp at the same URL on the same chain through the same wallet,
and any peer can change them. New WS messages:

```
Client → server:
  { type: "browser_navigate",     windowId, url: string }
  { type: "browser_set_wallet",   windowId, walletId: WalletId | null }
  { type: "browser_set_chain",    windowId, chainId: number }

Server → client:
  { type: "browser_state", windowId, currentUrl?, walletId?, chainId? }   // partial patch
```

LWW per field, same model as everything else.

### Mac OS 9 browser chrome

Inside the window body, before the iframe:

```
┌─[ < ][ > ][ ⟳ ][ 🏠 ]──────────────────────────────────────────┐
│  https://app.uniswap.org              [ chain ▾ ] [ wallet ▾ ] │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│             <ImpersonatorIframe src=currentUrl />              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

- Back/forward buttons drive a **per-window local history stack**. The
  stack is local-only (not synced) — peers shouldn't be able to step
  through your back history. The `currentUrl` is what's shared; how you
  got there is private to your client. When you click "back", you send
  `browser_navigate` with the previous URL.
- Reload: `iframeRef.current?.contentWindow?.location.reload()` if
  same-origin; otherwise `setAppUrl(currentUrl)` re-mounts. Use the
  latter — cross-origin reload via direct DOM access is blocked anyway.
- Address bar: enter to navigate. On submit: normalise (prepend
  `https://` if no scheme), then send `browser_navigate`.
- Chain dropdown: list of supported chains (mainnet, base, arbitrum,
  optimism, sepolia — same set as our Alchemy patterns in
  `~/.claude/CLAUDE.md`). Selecting one sends `browser_set_chain` and
  rotates `rpcUrl` accordingly. Source the rpcUrl from
  `NEXT_PUBLIC_ALCHEMY_API_KEY` per the global RPC rules — no
  llamarpc, no public RPCs.
- Wallet dropdown: lists the wallets defined in §5 (Cold, Hot). Choosing
  one binds that wallet's address to the impersonator provider for this
  window.

### Calldata interception → signing flow

The provider callbacks bridge dapp → our wallet:

```ts
// inside <BrowserWindow windowId={...} walletId={...}>
const wallet = useWallet(walletId);   // §5

const handleSendTransaction = async (tx: Transaction): Promise<string> => {
  // tx = { from, to, value?, data?, gas?, ... }  — viem-shaped
  const request: WalletSignRequest = {
    id: uuid(),
    walletId,
    kind: "transaction",
    origin: { kind: "browser", windowId, url: currentUrl },
    payload: tx,
    requestedBy: myPeerId,
    requestedAt: Date.now(),
  };
  const result = await wallet.requestSignature(request);
  // result is { hash: "0x..." } once enough sigs collected and broadcast
  return result.hash;
};

const handleSignMessage     = async (msg)    => wallet.requestSignature({...kind: "personal_sign", payload: msg }).then(r => r.signature);
const handleSignTypedData   = async (typed)  => wallet.requestSignature({...kind: "eip712",        payload: typed }).then(r => r.signature);
const handleChainSwitch     = (chainId)      => mesh.browserSetChain(windowId, chainId);
```

The crucial part: the dapp **sees a normal wallet response** (a tx hash
or a signature), but under the hood the request goes into a shared
queue, gets co-signed (Cold) or auto-signed (Hot), and the result is
piped back. From the dapp's perspective it's MetaMask, just slow.

### Sandbox compatibility

`@impersonator/iframe` injects its provider into the iframed page via
`postMessage`, which means the iframe **must** be able to receive
postMessages from our origin. The package handles its own sandbox
attributes internally (it sets what it needs); we should not pass an
explicit `sandbox` prop. This deviates from the locked-down sandbox in
§3 — and that's the right call, because:

- Browser windows are explicitly for trusted-by-the-host crypto dapps.
- Without `allow-same-origin` (or close to it) the impersonator's
  injection won't work for many dapps.
- We compensate with **wallet-level** isolation: the iframe can ask for
  signatures, but every signature goes through our review queue. There
  is no unattended path from "iframe wanted money" to "money moved".

That last point is the security model. Document it loudly in the
Browser window chrome ("Every signature reviewed before send.").

---

## 5. Co-op wallets (Cold multisig + Hot agent wallet)

Two wallet windows that live on the desktop. Both are **shared** —
any connected peer can see balances, pending requests, and history.
Their *signing rules* differ.

### Wallet types

```ts
type WalletId = "cold" | "hot";   // one of each per session, fixed for v1

type Wallet =
  | {
      id: "cold";
      kind: "safe";                            // Gnosis Safe
      address: `0x${string}` | null;           // null until deployed
      chainId: number;
      owners: `0x${string}`[];                 // session participants' wallet addresses
      threshold: number;                       // e.g. 2 of 3
      pending: SignRequest[];                  // collecting signatures
      history: ExecutedTx[];
    }
  | {
      id: "hot";
      kind: "eoa";                             // hot EOA — single key
      address: `0x${string}`;
      chainId: number;
      controllerPolicy: HotPolicy;             // who can trigger sends
      pending: SignRequest[];                  // very short-lived; auto-executes when policy passes
      history: ExecutedTx[];
    };

type HotPolicy =
  | { kind: "host-only" }                      // only host can authorise
  | { kind: "any-authenticated" }              // any peer can authorise (yolo)
  | { kind: "ai-agent"; agentId: string }      // an AI agent decides — sandbox/limits attached
  | { kind: "spend-limit"; perTx: bigint; perSession: bigint };  // permissionless under cap
```

Default policy for v1: `host-only` for hot. `ai-agent` is a follow-up.

### Cold wallet (Gnosis Safe)

A Safe deployed on the chosen chain at session start (or on first
`Go Live` — better, deploy lazily on first use to avoid spending gas on
sessions that never sign anything). Owners = the wallet addresses of
the host + SIWE-authenticated guests present in the session at the
moment of deploy. `threshold` chosen by the host (default `ceil(N*2/3)`).

Implications:

- **Password-only guests have no Safe vote.** They can see the wallet,
  see pending requests, comment via cursors, but they can't sign because
  they have no on-chain identity. UX-wise, render them as "viewer" rows
  in the owners list.
- Owners are baked in **at deploy time**. Adding/removing owners
  mid-session requires a Safe `addOwnerWithThreshold` /
  `removeOwner` tx, which itself needs threshold signatures. Out of v1
  scope — for v1, owners are frozen at deploy.
- Safe address is announced via the relay so every peer's wallet UI
  shows the same one. Stored per session, not persisted across relay
  restart in v1 (fits the in-memory rule).

### Sign-request lifecycle (Cold)

A `SignRequest` is the unit of co-signing:

```ts
type SignRequest = {
  id: string;                          // uuid
  walletId: WalletId;
  kind: "transaction" | "personal_sign" | "eip712";
  origin:
    | { kind: "browser"; windowId: AppWindowId; url: string }
    | { kind: "manual";  enteredBy: string /* peerId */ };
  payload: TransactionPayload | string | EIP712TypedData;
  requestedBy: string;                 // peerId
  requestedAt: number;
  signatures: Record<`0x${string}`, `0x${string}`>;   // ownerAddr → signature
  status: "pending" | "ready" | "executing" | "executed" | "rejected" | "expired";
  result?: { hash?: `0x${string}`; signature?: `0x${string}`; error?: string };
};
```

Flow:

1. Browser window (or manual UI) calls `wallet.requestSignature(...)`.
   Client sends `wallet_request` to relay; relay assigns id, broadcasts
   `wallet_request` to all peers.
2. A `<WalletWindow>` on every peer's desktop shows the new pending
   request. Owners get **Sign / Reject** buttons; non-owners see
   read-only.
3. Each owner that clicks Sign produces a Safe-style EIP-712 sig over
   the SafeTx hash and sends `wallet_sign { requestId, signature }`.
   Relay validates the sig against the owner set and adds it.
4. When `signatures.length >= threshold`, status flips to `ready`. The
   host (or any peer with the right — for v1: host only) clicks
   **Execute**, which submits `execTransaction` to the Safe via
   wagmi/viem. The host's wallet pays gas.
5. Tx hash → `wallet_executed { requestId, hash }`. Browser window's
   pending `sendTransaction` promise resolves with the hash. The dapp
   sees a successful response, possibly minutes later. (Some dapps will
   timeout — accept this; it's the price of multisig.)

For `personal_sign` / `eip712` requests, there's no on-chain execute —
once threshold is reached the relay assembles the combined Safe sig
(EIP-1271 contract sig format) and resolves the pending promise
client-side.

### Hot wallet (EOA)

A regular EOA whose **private key lives on the relay process**. This is
the spicy bit: the relay will be holding key material. Mitigations:

- Generated fresh per relay restart (in-memory v1). Address surfaced via
  `hello`. No persistence to disk in v1 — if the relay restarts, the
  hot wallet is a new address with zero balance.
- Funded explicitly by the host from the cold wallet (or out-of-band).
  No auto-funding.
- All hot-wallet signatures happen **server-side**: client sends
  `wallet_request`, the relay enforces `controllerPolicy`, and on pass
  it signs + broadcasts the tx itself using its own viem account. The
  client receives only `wallet_executed`.
- Spending bounded by `controllerPolicy.spend-limit` if configured.
- **Documented as a hot wallet:** small balances only, treated as
  burnable. README must say this in bold. Don't put real money on it.

The hot wallet is what an AI agent would drive — a future
`controllerPolicy: { kind: "ai-agent" }` lets a subprocess on the relay
issue `wallet_request`s autonomously, subject to spend-limit. Out of v1
scope but the data shape leaves room.

### Wire protocol additions

```
Client → server:
  { type: "wallet_create_safe",  owners: address[], threshold: number, chainId: number }
  { type: "wallet_request",      walletId, kind, payload, origin }
  { type: "wallet_sign",         requestId, signature }                 // cold only
  { type: "wallet_execute",      requestId }                            // cold only; host triggers
  { type: "wallet_reject",       requestId }
  { type: "wallet_set_policy",   walletId: "hot", policy: HotPolicy }   // host only

Server → client:
  { type: "wallet_state",        wallets: Wallet[] }                    // in `hello`, and on every change
  { type: "wallet_request_new",  request: SignRequest }
  { type: "wallet_request_upd",  requestId, signatures?, status?, result? }
  { type: "wallet_error",        op, reason, requestId? }
```

### Relay module: `packages/relay/src/wallets.ts`

Holds `Wallet[]`, the in-memory hot key (generated via
`viem/accounts.generatePrivateKey()`), and the request queue. Pure
functions for state mutations; `index.ts` does the WS plumbing. Also
needs a `viem` `PublicClient` per chain (Alchemy URLs from env per the
RPC rule) for nonce reads, gas estimation, and broadcast.

**Crucial:** the relay must reject any `wallet_sign` whose signature
doesn't recover to one of the Safe's owners. Don't trust the client
to send only valid sigs.

### React state shape additions

```ts
type PeerMeshState = {
  // ... existing + §1-3 ...

  wallets: Record<WalletId, Wallet>;
  walletRequests: SignRequest[];        // pending across all wallets

  walletCreateSafe: (owners: address[], threshold: number, chainId: number) => Promise<void>;
  walletRequest:    (input: { walletId, kind, payload, origin }) => Promise<{ hash?; signature? }>;
  walletSign:       (requestId: string) => Promise<void>;       // signs locally with wagmi, sends sig
  walletExecute:    (requestId: string) => Promise<void>;       // host only
  walletReject:     (requestId: string) => void;

  // Browser window state additions (from §4):
  browserNavigate:  (windowId, url) => void;
  browserSetWallet: (windowId, walletId | null) => void;
  browserSetChain:  (windowId, chainId) => void;
};
```

`walletRequest` returns a Promise that resolves when relay broadcasts
`wallet_request_upd { status: "executed", result: {...} }` for that id.
This is what `ImpersonatorIframeProvider`'s `sendTransaction` callback
awaits.

### Wallet window UI

A single `<WalletWindow walletId="cold">` and `<WalletWindow walletId="hot">`,
both rendered as standard `<Window>`s with their own slot ids
(`wallet-cold`, `wallet-hot`). Default position: right edge of the
desktop, stacked. Pre-seeded as fixtures so they appear on session
start (no double-click required) — but closable. Re-openable from
the menu bar's `Window → Cold Wallet` / `Window → Hot Wallet`.

Body sections:

```
┌─ COLD — 0xabcd…1234 (mainnet)  threshold 2 of 3 ────────┐
│  Balance: 0.42 ETH    Owners: 🟢 alice 🟢 bob 🟡 carol  │
├──────────────────────────────────────────────────────────┤
│ PENDING                                                  │
│ ◇ Uniswap swap 100 USDC → ETH  · 1 of 2 sigs            │
│   FROM: Browser (app.uniswap.org)  ·  by alice          │
│   [  Sign  ]  [  Reject  ]                              │
├──────────────────────────────────────────────────────────┤
│ HISTORY                                                  │
│ ✓ Approve USDC                              · 0xabc…  ↗ │
└──────────────────────────────────────────────────────────┘
```

Clicking `Sign` triggers wagmi's `signTypedData` over the SafeTx struct
locally with the user's connected wallet. Clicking `Execute` (only
visible to host once `signatures >= threshold`) sends the
`execTransaction` via `useWriteContract`.

### Security & footguns to call out before shipping

- **Hot wallet key on the relay.** Single point of compromise. Document
  as throwaway funds only. Rotate per session. Audit logs of every send.
- **Safe deploy gas paid by host.** First wallet creation can cost real
  ETH. Don't auto-deploy on session start — lazy on first request,
  surface a confirmation dialog showing the gas estimate.
- **Browser app sandbox is loose** (§4). All risk is gated by the wallet
  review queue — make sure the queue UI is unmissable. A sleeper rule
  for v2: rate-limit `wallet_request` per-window per-minute to stop a
  malicious dapp from spamming the queue.
- **Owner-set frozen at Safe deploy.** A guest who joins late cannot
  sign; an owner who leaves mid-session can still sign remotely if they
  kept a session cookie. Acceptable for v1; document.
- **Replay across chains.** Use chainId-aware EIP-712 domain separator
  in every signature payload. Safe handles this for `execTransaction`;
  we have to do it ourselves for personal_sign/typed_data flows.
- **What happens when Browser navigates mid-pending-request?** The
  pending `sendTransaction` Promise should still resolve when the tx
  eventually executes — it's keyed by request id, not URL. The dapp at
  the new URL won't know about it, but that's fine: the old dapp's
  promise resolves with the hash and any UI it left behind on the
  back-stack would update if revisited.

### Implementation order (slots into §5 of the original list)

After step 5 (real menu actions) and before step 6 (Finder UI), insert:

- **5a.** Browser app skeleton: `<BrowserWindow>` with chrome, address
  bar, no impersonator yet — just a plain iframe to prove window state
  syncs (`browser_navigate`, `browser_set_chain`).
- **5b.** Wire `@impersonator/iframe` into `<BrowserWindow>`. Wallet
  callbacks log to console (no wallet yet).
- **5c.** Hot wallet end-to-end: relay key generation, `wallet_request`
  queue, host-only policy, viem broadcast. Browser → Hot signs and
  sends.
- **5d.** Cold wallet: lazy Safe deploy, sig collection, threshold
  execute. Browser → Cold sits in pending until owners sign.
- **5e.** Wallet windows in the FS / menu bar / Window menu so they're
  re-openable.

---

## 6. End-to-end protocol summary

Full additions to the WS message vocabulary (reference for implementers):

### Client → server

| Type                  | Payload                                                         |
|-----------------------|------------------------------------------------------------------|
| `menu_open`           | `{ menuId }`                                                     |
| `menu_close`          | `{}`                                                             |
| `fs_create`           | `{ parentId, kind, name, content? }`                             |
| `fs_rename`           | `{ id, name }`                                                   |
| `fs_delete`           | `{ id }`                                                         |
| `fs_move`             | `{ id, newParentId }`                                            |
| `fs_update_content`   | `{ id, content }`                                                |
| `app_open`            | `{ fileId? , url?, title? }` (one of fileId or url+title)        |
| `app_close`           | `{ windowId }`                                                   |
| `slot_update`         | (existing) — extended: `z` may be the sentinel string `"front"`  |
| `browser_navigate`    | `{ windowId, url }`                                              |
| `browser_set_wallet`  | `{ windowId, walletId: WalletId \| null }`                       |
| `browser_set_chain`   | `{ windowId, chainId }`                                          |
| `wallet_create_safe`  | `{ owners, threshold, chainId }`                                 |
| `wallet_request`      | `{ walletId, kind, payload, origin }`                            |
| `wallet_sign`         | `{ requestId, signature }`                                       |
| `wallet_execute`      | `{ requestId }`                                                  |
| `wallet_reject`       | `{ requestId }`                                                  |
| `wallet_set_policy`   | `{ walletId: "hot", policy: HotPolicy }` (host only)             |

### Server → client

| Type                  | Payload                                                              |
|-----------------------|----------------------------------------------------------------------|
| `hello`               | (existing) + `fs`, `appWindows`, `openMenu`, `wallets`, `walletRequests` |
| `menu_state`          | `{ openMenu: OpenMenu }`                                             |
| `fs_node`             | `{ node }`                                                           |
| `fs_deleted`          | `{ ids: FsNodeId[] }`                                                |
| `fs_error`            | `{ op, reason, attemptedId? }`                                       |
| `app_opened`          | `{ window: AppWindow }`                                              |
| `app_closed`          | `{ windowId }`                                                       |
| `browser_state`       | `{ windowId, currentUrl?, walletId?, chainId? }` (partial patch)     |
| `wallet_state`        | `{ wallets: Wallet[] }` (full snapshot on any wallet change)         |
| `wallet_request_new`  | `{ request: SignRequest }`                                           |
| `wallet_request_upd`  | `{ requestId, signatures?, status?, result? }`                       |
| `wallet_error`        | `{ op, reason, requestId? }`                                         |

### React state shape additions to `usePeerMesh`

```ts
type PeerMeshState = {
  // ...existing fields...

  fs: Record<FsNodeId, FsNode>;
  fsCreate: (input: { parentId: FsNodeId; kind: "folder"|"file"; name: string; content?: FsFileContent }) => void;
  fsRename: (id: FsNodeId, name: string) => void;
  fsDelete: (id: FsNodeId) => void;
  fsMove:   (id: FsNodeId, newParentId: FsNodeId) => void;
  fsUpdate: (id: FsNodeId, content: FsFileContent) => void;

  appWindows: Record<AppWindowId, AppWindow>;
  appOpen:  (input: { fileId?: FsNodeId; url?: string; title?: string }) => void;
  appClose: (windowId: AppWindowId) => void;

  openMenu: { menuId: string; openedBy: string } | null;
  menuOpen:  (menuId: string) => void;
  menuClose: () => void;

  // Browser windows (§4)
  browserNavigate:  (windowId: AppWindowId, url: string) => void;
  browserSetWallet: (windowId: AppWindowId, walletId: WalletId | null) => void;
  browserSetChain:  (windowId: AppWindowId, chainId: number) => void;

  // Wallets (§5)
  wallets: Record<WalletId, Wallet>;
  walletRequests: SignRequest[];
  walletCreateSafe: (owners: `0x${string}`[], threshold: number, chainId: number) => Promise<void>;
  walletRequest:    (input: { walletId: WalletId; kind: SignRequest["kind"]; payload: unknown; origin: SignRequest["origin"] }) => Promise<{ hash?: `0x${string}`; signature?: `0x${string}` }>;
  walletSign:       (requestId: string) => Promise<void>;
  walletExecute:    (requestId: string) => Promise<void>;
  walletReject:     (requestId: string) => void;
};
```

`usePeerMesh` is already large. If this push tips it over ~700 lines it's
worth splitting WS-message handling into a single `dispatch(msg)` helper
and per-feature reducer functions in the same file — but **don't** split
into multiple hooks yet. One WS, one hook, one reconnection lifecycle is
the right shape; multiple hooks each holding their own WS would multiply
auth and reconnect bugs.

---

## 7. Implementation order

Each step is independently mergeable and shippable.

1. **Menu state on the relay.** `menu.ts` + `menu_open`/`menu_close`
   handlers + `menu_state` broadcast + `openMenu` in `hello`. Wire
   `MenuBar.tsx` to be controlled by `mesh.openMenu`. Dropdown UI
   inert-but-renders. Verifies the new shared-state pattern end-to-end
   before we touch any data model.

2. **FS data model + relay module + snapshot in hello.** No UI yet —
   write a single `<DebugFs>` panel that lists nodes, lets you create
   a folder, and renames. Establishes the FS protocol cleanly without
   blocking on Finder UI design.

3. **App windows + iframe rendering.** With FS in place, `Applications/`
   has `.app` files; double-clicking one (from `<DebugFs>` for now)
   spawns the iframe. This proves the slot-id reuse works for app
   windows.

4. **Server-assigned z + cascade offset.** Add the `"front"` sentinel
   for `slot_update.z`, change `focusSlot` to send it. Tests: open two
   apps from two browsers simultaneously; assert distinct positions
   and z values.

5. **Real menu actions.** Wire `New Folder`, `New File`, `Open URL…`,
   `Sign out` to their handlers. The `Window` menu auto-populates from
   `mesh.appWindows` (each item is "focus this window").

5a. **Browser app skeleton.** `<BrowserWindow>` chrome + address bar
   + back/forward + chain dropdown. Plain iframe inside (no impersonator
   yet). Proves `browser_navigate` / `browser_set_chain` sync.

5b. **Impersonator wiring.** Replace plain iframe with
   `@impersonator/iframe`. Wallet callbacks log to console. Address
   bar can visit Uniswap and the dapp loads with an injected provider
   pointing at a hard-coded address.

5c. **Hot wallet.** `wallets.ts` on the relay generates an EOA at boot,
   broadcasts via `wallet_state`. `wallet_request` queue with
   host-only policy. Relay signs + broadcasts via viem (Alchemy RPC).
   Browser → Hot wallet path resolves a real tx hash.

5d. **Cold wallet (Safe).** Lazy deploy on first `wallet_request`.
   Sig collection via wagmi `signTypedData` on each owner's client.
   Host-triggered `execTransaction` once threshold met. Browser → Cold
   path resolves a real tx hash via Safe.

5e. **Wallet windows.** `<WalletWindow walletId="cold">` /
   `<WalletWindow walletId="hot">` rendered as standard `<Window>`s
   (slot ids `wallet-cold`, `wallet-hot`). Pre-seeded so they appear
   on session start; closable; re-openable from `Window` menu.

6. **Finder + Desktop icons.** Pure client work over the now-stable
   FS protocol.

7. **(Deferred)** FS persistence, per-user permissions, app manifest
   with sandbox opt-ins, drag-to-rearrange in Finder, AI-agent
   `controllerPolicy` for Hot wallet, mid-session Safe owner edits.
   Out of v1 scope.

---

## 8. Open questions to resolve before coding

These are decisions the user (Austin) should make explicitly — defaults
listed but flagged as defaults, not commitments.

- **Should an audience viewer (HLS-only, no WS) see the menus and app
  windows?** They will, transitively, because OBS captures the host's
  browser composite. So *yes*, but they can't interact. Menus opening
  from "nowhere" mid-stream may confuse viewers. Suggest a small "BY:
  alice" badge next to the open dropdown so chat can see it's
  participant-driven, not host-driven. Default: ship the badge.

- **Do private/host-only apps make sense?** Probably yes eventually
  (admin panel, OBS controls). Out of scope for v1, but the data model
  should leave room: add `content.visibility?: "all" | "host"` field
  to `FsFileContent` now and ignore it client-side until v2. *Default:
  defer the field; YAGNI risk is low because adding it later is one
  optional property.*

- **Should `app_close` be host-only?** Erring egalitarian to match the
  slot rule. If guest griefing becomes a problem we add `requireHost`
  to the `app_close` handler — one-line change. Default: any peer.

- **Persistence for FS later — same JSON-on-disk pattern as slots, or
  introduce SQLite?** JSON is fine until the FS gets large. Default:
  mirror `desktop.ts`'s `scheduleSave()` pattern when we promote FS
  out of "in-memory only", introduce SQLite only if we hit obvious
  pain (concurrent writes, queries).
