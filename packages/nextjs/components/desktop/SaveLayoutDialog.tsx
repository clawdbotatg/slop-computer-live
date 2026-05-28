"use client";

import { useState } from "react";
import { Bevel, Button, TextField } from "~~/components/ui";

export type SaveLayoutDialogProps = {
  /** Suggested name pre-filled in the field (e.g. "Layout 3"). */
  defaultName: string;
  /** Existing layout names — used to warn that a save will overwrite. */
  existingNames: string[];
  onClose: () => void;
  onSave: (name: string) => void;
};

// Tiny modal that names a layout snapshot before it's written to
// localStorage. Matches the VideoShareDialog house style (fixed overlay +
// Bevel panel). Enter saves, Escape / backdrop-click cancels.
export const SaveLayoutDialog = ({ defaultName, existingNames, onClose, onSave }: SaveLayoutDialogProps) => {
  const [name, setName] = useState(defaultName);
  const trimmed = name.trim();
  const isDup = existingNames.some(n => n.toLowerCase() === trimmed.toLowerCase());

  const submit = () => {
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <Bevel style={{ padding: 18, maxWidth: 420, width: "100%" }}>
        <h2
          style={{
            margin: 0,
            marginBottom: 12,
            fontFamily: "var(--slop-font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            fontSize: 18,
          }}
        >
          Save layout
        </h2>
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--slop-text-muted)",
            marginBottom: 4,
          }}
        >
          Layout name
        </div>
        <TextField
          autoFocus
          value={name}
          placeholder="e.g. Demo setup"
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          style={{ width: "100%" }}
        />
        {isDup ? (
          <p style={{ color: "var(--slop-magenta, #ff3ec9)", fontSize: 11, marginTop: 8 }}>
            A layout named “{trimmed}” already exists — saving overwrites it.
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!trimmed}>
            {isDup ? "Overwrite" : "Save"}
          </Button>
        </div>
      </Bevel>
    </div>
  );
};

export default SaveLayoutDialog;
