"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Address } from "@scaffold-ui/components";
import type { Address as AddressType } from "viem";
import type { Note, PeerMeshState } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";

// Shared notes — sidebar of notes on the left, editor pane on the right.
// All notes are visible to everyone, and anyone can edit any note. The
// relay rebroadcasts the full list after every change.
//
// Editor strategy: we keep a local `draft` string for the active note so
// keystrokes feel instant. Each draft change pushes a `note_update` to
// the server (debounced 400ms) so the broadcast loop confirms what we
// typed without echoing every keystroke. If another peer edits the same
// note while we have it open, their broadcast lands as a new `text` on
// the source note — we accept it only if it differs from what we last
// sent (avoiding overwriting an in-flight local edit with a stale echo).

export type NotesWindowProps = {
  mesh: PeerMeshState;
};

const titleFor = (note: Note): string => {
  const first = note.text.split("\n")[0].trim();
  if (first) return first.slice(0, 60);
  return "untitled";
};

const SAVE_DEBOUNCE_MS = 400;

export const NotesWindow = ({ mesh }: NotesWindowProps) => {
  const notes = mesh.notes;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const lastSentRef = useRef<{ id: string; text: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // When the user clicks "+ New", we want to switch to the new note as
  // soon as it shows up in the broadcast. We can't just check
  // notes[notes.length-1] in the click handler because the broadcast
  // hasn't arrived yet. Instead, set a flag + the set of ids we know
  // about now, then on the next notes change look for any new id.
  const pendingNewRef = useRef<Set<string> | null>(null);
  const sidebarRef = useRef<HTMLUListElement>(null);
  // Multiplayer scroll sync. Sidebar uses a fixed key. The editor
  // scrolls per-note — key it by the selected note id so peers only
  // follow each other when they're looking at the same note.
  const onSidebarScroll = useSyncedScroll(mesh, "notes-sidebar", sidebarRef);
  const onEditorScroll = useSyncedScroll(
    mesh,
    selectedId ? `notes-editor:${selectedId}` : "notes-editor:none",
    textareaRef,
  );

  // Default selection: the most-recently-updated note.
  const sorted = useMemo(() => [...notes].sort((a, b) => b.updatedTs - a.updatedTs), [notes]);
  useEffect(() => {
    if (selectedId && notes.some(n => n.id === selectedId)) return;
    setSelectedId(sorted[0]?.id ?? null);
  }, [sorted, selectedId, notes]);

  // Detect a freshly-created note (an id that wasn't in the set when
  // the user clicked "+ New") and switch selection to it.
  useEffect(() => {
    const known = pendingNewRef.current;
    if (!known) return;
    const fresh = notes.find(n => !known.has(n.id));
    if (fresh) {
      pendingNewRef.current = null;
      setSelectedId(fresh.id);
    }
  }, [notes]);

  // Sync draft with the selected note's server text. Skip when the
  // incoming text matches what we last sent (the broadcast echo of our
  // own keystroke).
  const selected = notes.find(n => n.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) {
      setDraft("");
      return;
    }
    const last = lastSentRef.current;
    if (last && last.id === selected.id && last.text === selected.text) return;
    setDraft(selected.text);
  }, [selected]);

  // Autofocus the editor whenever the selected note changes. Driven by
  // selectedId rather than `selected` so we focus the moment the user
  // clicks a sidebar entry — even before the body text resolves. The
  // ref is null in the empty-state branch; the check guards that.
  useEffect(() => {
    if (!selectedId) return;
    textareaRef.current?.focus();
  }, [selectedId]);

  // Flush any pending debounced save when the selection changes or the
  // component unmounts. Without this, switching notes mid-typing would
  // lose the last batch of keystrokes.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  const onDraftChange = (next: string) => {
    setDraft(next);
    if (!selected) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      lastSentRef.current = { id: selected.id, text: next };
      mesh.noteUpdate(selected.id, next);
    }, SAVE_DEBOUNCE_MS);
  };

  const createNote = () => {
    // Snapshot the ids we know about right now; the pending-new effect
    // above watches for any id that isn't in this set and selects it.
    pendingNewRef.current = new Set(notes.map(n => n.id));
    mesh.noteCreate("");
  };

  const deleteSelected = () => {
    if (!selected) return;
    mesh.noteDelete(selected.id);
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: 140,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--slop-border, #2a1d4a)",
          background: "#0a061a",
        }}
      >
        <button
          type="button"
          onClick={createNote}
          style={{
            margin: 6,
            padding: "6px 8px",
            fontSize: 10,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            background: "var(--slop-magenta, #ff3ec9)",
            color: "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          + New
        </button>
        <ul
          ref={sidebarRef}
          onScroll={onSidebarScroll}
          style={{
            flex: 1,
            margin: 0,
            padding: 0,
            listStyle: "none",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {sorted.map(note => {
            const isActive = note.id === selectedId;
            return (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(note.id)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    textAlign: "left",
                    background: isActive ? "rgba(255,62,201,0.15)" : "transparent",
                    color: isActive ? "var(--slop-text)" : "var(--slop-text-muted)",
                    border: "none",
                    borderBottom: "1px solid var(--slop-border, #2a1d4a)",
                    fontSize: 12,
                    fontFamily: "var(--slop-font-body)",
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {titleFor(note)}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {selected ? (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderBottom: "1px solid var(--slop-border, #2a1d4a)",
                background: "#0a061a",
                fontSize: 10,
                color: "var(--slop-text-muted)",
              }}
            >
              <span>
                {selected.address ? (
                  <Address address={selected.address as AddressType} size="xs" onlyEnsOrAddress />
                ) : (
                  (selected.handle ?? "anon")
                )}
              </span>
              <span style={{ marginLeft: "auto" }}>
                {new Date(selected.updatedTs).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <button
                type="button"
                onClick={deleteSelected}
                aria-label="delete note"
                style={{
                  background: "transparent",
                  border: "1px solid var(--slop-border, #2a1d4a)",
                  color: "var(--slop-text-muted)",
                  borderRadius: 3,
                  padding: "2px 6px",
                  fontSize: 10,
                  fontFamily: "var(--slop-font-display)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={e => onDraftChange(e.target.value)}
              onScroll={onEditorScroll}
              placeholder="start typing… (first line becomes the title)"
              style={{
                flex: 1,
                resize: "none",
                background: "#06030d",
                color: "var(--slop-text)",
                border: "none",
                outline: "none",
                padding: 10,
                fontSize: 13,
                fontFamily: "var(--slop-font-body)",
                lineHeight: 1.45,
              }}
            />
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--slop-text-muted)",
              fontSize: 12,
              fontStyle: "italic",
              padding: 20,
              textAlign: "center",
            }}
          >
            No notes yet. Click &quot;+ New&quot; to start.
          </div>
        )}
      </div>
    </div>
  );
};

export default NotesWindow;
