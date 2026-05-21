"use client";

import { useMemo, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import type { PeerMeshState, TodoItem } from "~~/hooks/usePeerMesh";
import { shortAddress } from "~~/hooks/useSession";

// Shared todo list. Anyone signed in can add, toggle, edit or delete any
// item — the relay is the source of truth and broadcasts the full list
// after every change. No optimistic insert needed; the broadcast echo
// arrives in <100ms locally.
//
// Reorder: native HTML5 drag-and-drop on each row. While dragging we
// keep a local `localOrder` that snaps the picked row to the hovered
// slot so the UI updates immediately; on drop we send the new id list
// to the relay, which rebroadcasts the canonical order and clears the
// local override.

export type TodoWindowProps = {
  mesh: PeerMeshState;
};

const sourceLabel = (item: TodoItem, customNames: Record<string, string>): string => {
  const custom = item.address ? customNames[item.address.toLowerCase()] : undefined;
  if (custom) return custom;
  if (item.handle) return item.handle;
  if (item.address) return shortAddress(item.address);
  return "anon";
};

export const TodoWindow = ({ mesh }: TodoWindowProps) => {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);

  const serverItems = mesh.todos;
  // While dragging, render from localOrder. Once the drop completes and
  // the relay broadcast lands, the localOrder matches serverItems and
  // we fall back to the server's view.
  const items = useMemo(() => {
    if (!localOrder) return serverItems;
    const byId = new Map(serverItems.map(i => [i.id, i]));
    const out: TodoItem[] = [];
    const used = new Set<string>();
    for (const id of localOrder) {
      const it = byId.get(id);
      if (it && !used.has(id)) {
        out.push(it);
        used.add(id);
      }
    }
    for (const it of serverItems) {
      if (!used.has(it.id)) out.push(it);
    }
    return out;
  }, [serverItems, localOrder]);
  const remaining = useMemo(() => items.filter(i => !i.done).length, [items]);
  const completed = items.length - remaining;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    mesh.todoAdd(text);
    setDraft("");
  };

  const startEdit = (item: TodoItem) => {
    setEditingId(item.id);
    setEditDraft(item.text);
  };

  const commitEdit = () => {
    if (!editingId) return;
    const text = editDraft.trim();
    if (text) mesh.todoUpdate(editingId, text);
    setEditingId(null);
    setEditDraft("");
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}>
        {items.length === 0 ? (
          <div
            style={{
              color: "var(--slop-text-muted)",
              fontSize: 12,
              fontStyle: "italic",
              padding: 12,
              textAlign: "center",
            }}
          >
            No todos yet. Add the first one below.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {items.map(item => {
              const isEditing = editingId === item.id;
              const isDragging = draggingId === item.id;
              return (
                <li
                  key={item.id}
                  draggable={!isEditing}
                  onDragStart={e => {
                    setDraggingId(item.id);
                    setLocalOrder(items.map(i => i.id));
                    e.dataTransfer.effectAllowed = "move";
                    try {
                      // Required by Firefox; the actual value is unused.
                      e.dataTransfer.setData("text/plain", item.id);
                    } catch {
                      /* some browsers throw on setData in synthetic events */
                    }
                  }}
                  onDragOver={e => {
                    if (!draggingId || draggingId === item.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setLocalOrder(prev => {
                      const cur = prev ?? items.map(i => i.id);
                      const fromIdx = cur.indexOf(draggingId);
                      const toIdx = cur.indexOf(item.id);
                      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return cur;
                      const next = cur.slice();
                      next.splice(fromIdx, 1);
                      next.splice(toIdx, 0, draggingId);
                      return next;
                    });
                  }}
                  onDragEnd={() => {
                    if (localOrder) {
                      const serverIds = serverItems.map(i => i.id);
                      const sameOrder =
                        localOrder.length === serverIds.length && localOrder.every((id, i) => id === serverIds[i]);
                      if (!sameOrder) mesh.todoReorder(localOrder);
                    }
                    setDraggingId(null);
                    setLocalOrder(null);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "6px 8px",
                    background: item.done ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)",
                    border: "1px solid var(--slop-border, #2a1d4a)",
                    borderRadius: 4,
                    opacity: isDragging ? 0.4 : 1,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      color: "var(--slop-text-muted)",
                      fontSize: 14,
                      lineHeight: 1,
                      cursor: "grab",
                      userSelect: "none",
                      paddingTop: 1,
                    }}
                    title="drag to reorder"
                  >
                    ⋮⋮
                  </span>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => mesh.todoToggle(item.id)}
                    style={{ marginTop: 3, cursor: "pointer" }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        value={editDraft}
                        onChange={e => setEditDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={e => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") {
                            setEditingId(null);
                            setEditDraft("");
                          }
                        }}
                        style={{
                          width: "100%",
                          padding: "4px 6px",
                          fontSize: 13,
                          fontFamily: "var(--slop-font-body)",
                          background: "#0e0820",
                          color: "var(--slop-text)",
                          border: "1px solid var(--slop-magenta, #ff3ec9)",
                          borderRadius: 3,
                          outline: "none",
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          color: item.done ? "var(--slop-text-muted)" : "var(--slop-text)",
                          textDecoration: item.done ? "line-through" : "none",
                          fontSize: 13,
                          fontFamily: "var(--slop-font-body)",
                          cursor: "text",
                          wordBreak: "break-word",
                        }}
                      >
                        {item.text}
                      </button>
                    )}
                    <div style={{ fontSize: 10, color: "var(--slop-text-muted)", marginTop: 2 }}>
                      {item.address && !mesh.customNames[item.address.toLowerCase()] ? (
                        <Address address={item.address as AddressType} size="xs" onlyEnsOrAddress />
                      ) : (
                        <span>{sourceLabel(item, mesh.customNames)}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => mesh.todoDelete(item.id)}
                    aria-label="delete"
                    style={{
                      flex: "0 0 auto",
                      background: "transparent",
                      border: "none",
                      color: "var(--slop-text-muted)",
                      fontSize: 14,
                      lineHeight: 1,
                      cursor: "pointer",
                      padding: "2px 4px",
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          placeholder="add a todo…"
          style={{
            flex: 1,
            padding: "6px 8px",
            fontSize: 13,
            fontFamily: "var(--slop-font-body)",
            background: "#0e0820",
            color: "var(--slop-text)",
            border: "1px solid var(--slop-border, #2a1d4a)",
            borderRadius: 4,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          style={{
            padding: "6px 12px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            background: draft.trim() ? "var(--slop-magenta, #ff3ec9)" : "transparent",
            color: draft.trim() ? "#06030d" : "var(--slop-text-muted)",
            border: "1px solid var(--slop-border, #2a1d4a)",
            borderRadius: 4,
            cursor: draft.trim() ? "pointer" : "not-allowed",
          }}
        >
          Add
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          fontSize: 10,
          color: "var(--slop-text-muted)",
          borderTop: "1px solid var(--slop-border, #2a1d4a)",
          background: "#06030d",
        }}
      >
        <span>{remaining} open</span>
        <span>·</span>
        <span>{completed} done</span>
        {completed > 0 ? (
          <button
            type="button"
            onClick={() => mesh.todoClearDone()}
            style={{
              marginLeft: "auto",
              marginRight: 50,
              padding: "2px 6px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: "transparent",
              color: "var(--slop-text-muted)",
              border: "1px solid var(--slop-border, #2a1d4a)",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Clear done
          </button>
        ) : null}
      </div>
    </div>
  );
};

export default TodoWindow;
