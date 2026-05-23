"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Action surfaced in the Ctrl+Shift+Space launcher. Each action is one row
// in the result list — apps and menu items get flattened into a single
// `CommandAction[]` upstream so the palette stays dumb (it just filters,
// renders, and fires).
export type CommandAction = {
  id: string;
  label: string;
  group?: string;
  icon?: string;
  keywords?: string;
  run: () => void;
};

// Returns -1 when `label` doesn't match `query` at all. Higher = better.
// Exact > startsWith > substring > subsequence. Subsequence is the loose
// fuzzy fallback so "amjc" can still hit "Music" if needed.
function scoreMatch(query: string, label: string): number {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (l === q) return 1000;
  if (l.startsWith(q)) return 500 - (l.length - q.length);
  const idx = l.indexOf(q);
  if (idx >= 0) return 200 - idx;
  let li = 0;
  for (const ch of q) {
    li = l.indexOf(ch, li);
    if (li === -1) return -1;
    li += 1;
  }
  return 50;
}

const MAX_RESULTS = 6;

export function CommandPalette({ actions }: { actions: CommandAction[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkey. Ctrl+Shift+Space AND Cmd+Shift+Space both work so it's
  // muscle-memory regardless of platform. e.code is checked against
  // "Space" so keyboard layouts that put Space somewhere weird still hit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isToggle = e.code === "Space" && e.shiftKey && (e.ctrlKey || e.metaKey);
      if (isToggle) {
        e.preventDefault();
        setOpen(v => !v);
        setQuery("");
        setHighlight(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-focus the input the moment the modal mounts so the user can just
  // start typing without a second click.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return actions.slice(0, MAX_RESULTS);
    return actions
      .map(a => ({ a, score: scoreMatch(q, `${a.label} ${a.keywords ?? ""}`.trim()) }))
      .filter(x => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_RESULTS)
      .map(x => x.a);
  }, [query, actions]);

  // Clamp highlight back to 0 when the result list shrinks beneath it
  // (e.g. user types more characters and the previously-highlighted row
  // is no longer in the top-N).
  useEffect(() => {
    if (highlight >= results.length) setHighlight(0);
  }, [highlight, results.length]);

  if (!open) return null;

  const fire = (a: CommandAction) => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    // Defer one tick so the Enter keystroke that triggered this doesn't
    // get re-handled by whatever window the action just opened (e.g. an
    // input that auto-focuses on mount).
    setTimeout(() => a.run(), 0);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={e => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(6, 3, 13, 0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "18vh",
        zIndex: 12000,
      }}
    >
      <div
        style={{
          width: "min(560px, 90vw)",
          background: "var(--slop-panel-glass)",
          border: "2px solid var(--slop-magenta)",
          borderRadius: 8,
          boxShadow: "0 24px 64px rgba(0,0,0,0.65), 0 0 32px rgba(255,62,201,0.45)",
          overflow: "hidden",
          fontFamily: "var(--slop-font-body)",
          color: "var(--slop-text)",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={e => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight(h => Math.min(h + 1, Math.max(0, results.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight(h => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const pick = results[highlight];
              if (pick) fire(pick);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
          placeholder="type an app or menu item…"
          spellCheck={false}
          autoComplete="off"
          style={{
            width: "100%",
            padding: "16px 18px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--slop-text)",
            fontFamily: "var(--slop-font-display)",
            fontSize: 18,
            letterSpacing: "0.04em",
          }}
        />
        {results.length > 0 ? (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              borderTop: "1px solid rgba(255, 62, 201, 0.3)",
              maxHeight: "50vh",
              overflowY: "auto",
            }}
          >
            {results.map((a, i) => {
              const active = i === highlight;
              return (
                <li
                  key={a.id}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={e => {
                    // Use mousedown so the click fires before the
                    // backdrop's mousedown-to-close path can swallow it.
                    e.preventDefault();
                    fire(a);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 18px",
                    cursor: "pointer",
                    background: active ? "rgba(255, 62, 201, 0.25)" : "transparent",
                    color: active ? "#fff" : "var(--slop-text)",
                  }}
                >
                  {a.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.icon}
                      alt=""
                      width={24}
                      height={24}
                      style={{ imageRendering: "pixelated", flexShrink: 0 }}
                    />
                  ) : (
                    <span
                      style={{
                        width: 24,
                        textAlign: "center",
                        color: "var(--slop-cyan)",
                        flexShrink: 0,
                      }}
                    >
                      ▶
                    </span>
                  )}
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.label}
                  </span>
                  {a.group ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--slop-text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        flexShrink: 0,
                      }}
                    >
                      {a.group}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : query.trim() ? (
          <div
            style={{
              padding: "14px 18px",
              color: "var(--slop-text-muted)",
              borderTop: "1px solid rgba(255, 62, 201, 0.3)",
              fontSize: 13,
            }}
          >
            no match
          </div>
        ) : null}
      </div>
    </div>
  );
}
