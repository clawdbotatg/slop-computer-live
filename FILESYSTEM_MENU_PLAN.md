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

## 4. End-to-end protocol summary

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

### Server → client

| Type            | Payload                                                              |
|-----------------|----------------------------------------------------------------------|
| `hello`         | (existing) + `fs: FsNode[]`, `appWindows: AppWindow[]`, `openMenu`   |
| `menu_state`    | `{ openMenu: OpenMenu }`                                             |
| `fs_node`       | `{ node }`                                                           |
| `fs_deleted`    | `{ ids: FsNodeId[] }`                                                |
| `fs_error`      | `{ op, reason, attemptedId? }`                                       |
| `app_opened`    | `{ window: AppWindow }`                                              |
| `app_closed`    | `{ windowId }`                                                       |

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
};
```

`usePeerMesh` is already large. If this push tips it over ~700 lines it's
worth splitting WS-message handling into a single `dispatch(msg)` helper
and per-feature reducer functions in the same file — but **don't** split
into multiple hooks yet. One WS, one hook, one reconnection lifecycle is
the right shape; multiple hooks each holding their own WS would multiply
auth and reconnect bugs.

---

## 5. Implementation order

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

6. **Finder + Desktop icons.** Pure client work over the now-stable
   FS protocol.

7. **(Deferred)** FS persistence, per-user permissions, app manifest
   with sandbox opt-ins, drag-to-rearrange in Finder. Out of v1 scope.

---

## 6. Open questions to resolve before coding

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
