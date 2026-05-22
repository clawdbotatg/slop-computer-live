"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingBar } from "~~/components/ui";
import type { PeerMeshState, ResearchResult, ResearchSocials } from "~~/hooks/usePeerMesh";

// Multiplayer guest-research dossier. Every transition lives on the
// relay (research-state.ts) and broadcasts to every peer:
//   1. someone hits "Look up"     → everyone sees the shared loading bar
//   2. lookup returns             → everyone sees the prefilled form
//   3. someone hits "Research"    → everyone sees the shared loading bar
//   4. dossier returns            → everyone reads the same answers
// Form-editing is local-only by design — the host can polish the
// prefilled fields without broadcasting keystrokes. Only the submit
// click commits + broadcasts. Last writer wins if two peers submit
// simultaneously (relay refuses overlapping jobs with 409).

const LOOKUP_ASSUMED_MS = 15_000;
const RESEARCH_ASSUMED_MS = 100_000;
const PROGRESS_TICK_MS = 200;
const PROGRESS_CAP = 95;

// Drive the shared loading bar off the relay's `startedAt`, not a
// local "I just clicked the button" stopwatch — that way every peer's
// bar (the submitter and the late-joiner who just unlocked the window)
// shows the same progress at the same time.
function useSharedProgress(startedAt: number | null, durationMs: number): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (startedAt == null) {
      setProgress(0);
      return;
    }
    const tick = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      setProgress(Math.min(PROGRESS_CAP, (elapsed / durationMs) * 100));
    };
    tick();
    const id = setInterval(tick, PROGRESS_TICK_MS);
    return () => clearInterval(id);
  }, [startedAt, durationMs]);
  return progress;
}

const PANEL_BG = "#0a061a";
const BORDER = "1px solid rgba(255,62,201,0.25)";
const ACCENT = "var(--slop-magenta, #ff3ec9)";

const EMPTY_SOCIALS: ResearchSocials = {};

export const ResearchWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const rs = mesh.researchState;
  const lookupRunning = rs.job?.kind === "lookup";
  const researchRunning = rs.job?.kind === "research";

  // ---- Phase 1: lookup screen ---------------------------------------------
  // Local typing state for the freeform "name or @handle" input. Kept
  // local so spectators don't see keystrokes — only the submit
  // broadcasts. Pre-seeded from the shared state on mount so a
  // late-joiner sees what the room is currently asking about.
  const [lookupQuery, setLookupQuery] = useState(rs.lookupQuery);
  useEffect(() => {
    // If the shared query changes while we're NOT typing (e.g. someone
    // else hit Look up), reflect it. We don't try to handle "we're
    // mid-edit, ignore foreign update" — the input is small and the
    // shared phase tells us when our edits are no longer relevant.
    if (!lookupRunning) return;
    setLookupQuery(rs.lookupQuery);
  }, [rs.lookupQuery, lookupRunning]);

  // ---- Phase 2: form screen -----------------------------------------------
  // Local-edit copies of the form fields. Seeded from the shared state
  // whenever the shared form values change (e.g. a fresh lookup result
  // lands). Edits stay local until the host clicks Research.
  const [name, setName] = useState(rs.name);
  const [socials, setSocials] = useState<ResearchSocials>(rs.socials);
  const [notes, setNotes] = useState(rs.notes);

  useEffect(() => {
    if (rs.phase === "form" || rs.phase === "research-pending" || rs.phase === "done") {
      setName(rs.name);
      setSocials(rs.socials);
      setNotes(rs.notes);
    }
  }, [rs.phase, rs.name, rs.socials, rs.notes]);

  const setSocialField = (k: keyof ResearchSocials, v: string) => setSocials(s => ({ ...s, [k]: v }));

  // ---- Submit handlers ----------------------------------------------------
  const runLookup = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = lookupQuery.trim();
      if (!q) return;
      mesh.researchLookup(q);
    },
    [lookupQuery, mesh],
  );

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      if (!trimmedName) return;
      mesh.researchStart({
        name: trimmedName,
        socials,
        notes: notes.trim() || undefined,
      });
    },
    [name, socials, notes, mesh],
  );

  const startOver = useCallback(() => {
    setLookupQuery("");
    setName("");
    setSocials(EMPTY_SOCIALS);
    setNotes("");
    mesh.researchReset();
  }, [mesh]);

  const researchProgress = useSharedProgress(researchRunning ? rs.job!.startedAt : null, RESEARCH_ASSUMED_MS);

  // ---- Render gating ------------------------------------------------------
  // Lookup screen renders for idle + lookup-pending. Form/result screen
  // renders for everything else. `done` keeps showing the form so the
  // host can tweak + re-research if needed.
  if (rs.phase === "idle" || rs.phase === "lookup-pending") {
    return (
      <LookupPhase
        query={lookupQuery}
        setQuery={setLookupQuery}
        onSubmit={runLookup}
        loading={lookupRunning}
        startedAt={lookupRunning ? rs.job!.startedAt : null}
        startedBy={lookupRunning ? rs.job!.startedBy : null}
        error={rs.error}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        overflow: "hidden",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          padding: 10,
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
          background: PANEL_BG,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          flexShrink: 0,
        }}
      >
        <LabeledInput label="Name" value={name} onChange={setName} placeholder="Vitalik Buterin" autoFocus full />
        <LabeledInput
          label="Twitter / X"
          value={socials.twitter ?? ""}
          onChange={v => setSocialField("twitter", v)}
          placeholder="@vitalikbuterin"
        />
        <LabeledInput
          label="GitHub"
          value={socials.github ?? ""}
          onChange={v => setSocialField("github", v)}
          placeholder="vbuterin"
        />
        <LabeledInput
          label="LinkedIn"
          value={socials.linkedin ?? ""}
          onChange={v => setSocialField("linkedin", v)}
          placeholder="profile url or handle"
        />
        <LabeledInput
          label="Website"
          value={socials.website ?? ""}
          onChange={v => setSocialField("website", v)}
          placeholder="https://vitalik.ca"
        />
        <LabeledInput
          label="Other"
          value={socials.other ?? ""}
          onChange={v => setSocialField("other", v)}
          placeholder="warpcast, farcaster, anything"
          full
        />
        <LabeledInput
          label="Host notes (optional)"
          value={notes}
          onChange={setNotes}
          placeholder="anything you already know about them"
          full
        />
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={startOver}
            disabled={researchRunning}
            style={{
              padding: "6px 12px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              background: "transparent",
              color: "var(--slop-text-muted)",
              border: "1px solid rgba(255,62,201,0.25)",
              borderRadius: 4,
              cursor: researchRunning ? "not-allowed" : "pointer",
              opacity: researchRunning ? 0.5 : 1,
            }}
            title={researchRunning ? "wait for the in-flight job to finish" : "clear and start over"}
          >
            Start over
          </button>
          <button
            type="submit"
            disabled={!name.trim() || researchRunning}
            style={{
              padding: "6px 14px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              background: !name.trim() || researchRunning ? "rgba(255,62,201,0.25)" : ACCENT,
              color: "#06030d",
              border: "none",
              borderRadius: 4,
              cursor: !name.trim() || researchRunning ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {researchRunning ? "Researching…" : "Research"}
          </button>
        </div>
      </form>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {rs.error ? (
          <div
            style={{
              padding: 10,
              border: "1px solid rgba(255,62,62,0.4)",
              background: "rgba(255,62,62,0.08)",
              borderRadius: 4,
              fontSize: 12,
              color: "#ff9a9a",
            }}
          >
            {rs.error}
          </div>
        ) : null}

        {!rs.result && !researchRunning ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--slop-text-muted)", fontSize: 12 }}>
            Fill in the guest&apos;s name and any socials, then hit Research. Takes ~10–30 seconds.
          </div>
        ) : null}

        {researchRunning ? (
          <div
            style={{
              padding: 24,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              color: "var(--slop-text-muted)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            <LoadingBar cells={20} progress={researchProgress} caption="researching" />
            <div>
              vanilla knowledge + web research running in parallel — usually a minute or two
              {rs.job?.startedBy ? <> · started by {rs.job.startedBy}</> : null}
            </div>
          </div>
        ) : null}

        {rs.result ? <ResultView result={rs.result} /> : null}
      </div>
    </div>
  );
};

type LabeledInputProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  full?: boolean;
};

const LabeledInput = ({ label, value, onChange, placeholder, autoFocus, full }: LabeledInputProps) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 2, gridColumn: full ? "1 / -1" : undefined }}>
    <span
      style={{
        fontSize: 9,
        fontFamily: "var(--slop-font-display)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--slop-text-muted)",
      }}
    >
      {label}
    </span>
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      style={{
        background: "#06030d",
        color: "var(--slop-text)",
        border: BORDER,
        borderRadius: 4,
        padding: "5px 8px",
        font: "inherit",
        fontSize: 13,
        outline: "none",
      }}
    />
  </label>
);

type LookupPhaseProps = {
  query: string;
  setQuery: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  startedAt: number | null;
  startedBy: string | null;
  error: string | null;
};

const LookupPhase = ({ query, setQuery, onSubmit, loading, startedAt, startedBy, error }: LookupPhaseProps) => {
  const progress = useSharedProgress(startedAt, LOOKUP_ASSUMED_MS);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#06030d",
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
        padding: 24,
        gap: 16,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--slop-font-display)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--slop-text-muted)",
        }}
      >
        Guest research
      </div>
      <form
        onSubmit={onSubmit}
        style={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 10 }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 9,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--slop-text-muted)",
            }}
          >
            Twitter/X or name
          </span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="@vitalikbuterin   or   Vitalik Buterin"
            autoFocus
            spellCheck={false}
            disabled={loading}
            style={{
              background: "#06030d",
              color: "var(--slop-text)",
              border: BORDER,
              borderRadius: 4,
              padding: "10px 12px",
              font: "inherit",
              fontSize: 16,
              outline: "none",
              textAlign: "center",
            }}
          />
        </label>
        <button
          type="submit"
          disabled={!query.trim() || loading}
          style={{
            padding: "10px 14px",
            fontSize: 11,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            background: !query.trim() || loading ? "rgba(255,62,201,0.25)" : ACCENT,
            color: "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: !query.trim() || loading ? "not-allowed" : "pointer",
            fontWeight: 700,
          }}
        >
          {loading ? "Looking up…" : "Look up"}
        </button>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginTop: 4 }}>
            <LoadingBar cells={16} progress={progress} caption="looking up" />
            {startedBy ? (
              <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>started by {startedBy}</div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div
            style={{
              padding: 10,
              border: "1px solid rgba(255,62,62,0.4)",
              background: "rgba(255,62,62,0.08)",
              borderRadius: 4,
              fontSize: 12,
              color: "#ff9a9a",
            }}
          >
            {error}
          </div>
        ) : null}
        <div style={{ fontSize: 11, color: "var(--slop-text-muted)", textAlign: "center", marginTop: 4 }}>
          Resolves to a name, socials, and a one-line identity sketch. Anyone in the room can edit the form before going
          deeper.
        </div>
      </form>
    </div>
  );
};

const ResultView = ({ result }: { result: ResearchResult }) => {
  const handle = result.query.socials.twitter?.replace(/^@/, "");
  return (
    <>
      <section>
        <div
          style={{ fontSize: 18, fontWeight: 700, color: "var(--slop-text)", fontFamily: "var(--slop-font-display)" }}
        >
          {result.query.name}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--slop-text-muted)",
            marginTop: 4,
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
          {handle ? <SocialLink label="x" href={`https://x.com/${handle}`} text={`@${handle}`} /> : null}
          {result.query.socials.github ? (
            <SocialLink
              label="gh"
              href={`https://github.com/${result.query.socials.github.replace(/^@/, "")}`}
              text={result.query.socials.github}
            />
          ) : null}
          {result.query.socials.linkedin ? (
            <SocialLink label="li" href={hrefFor(result.query.socials.linkedin)} text={result.query.socials.linkedin} />
          ) : null}
          {result.query.socials.website ? (
            <SocialLink label="www" href={hrefFor(result.query.socials.website)} text={result.query.socials.website} />
          ) : null}
          {result.query.socials.other ? (
            <span style={{ opacity: 0.7 }}>other: {result.query.socials.other}</span>
          ) : null}
        </div>
      </section>

      <Section title="Vanilla LLM knowledge" error={result.errors.vanilla}>
        {result.vanilla ? <Prose text={result.vanilla} /> : <Empty>No baseline available.</Empty>}
      </Section>

      <Section title="Researched description" error={result.errors.researched}>
        {result.researched ? <Prose text={result.researched} /> : <Empty>No research output.</Empty>}
      </Section>

      <Section title={`Interview questions (${result.questions.length})`}>
        {result.questions.length > 0 ? (
          <ol style={{ paddingLeft: 20, margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--slop-text)" }}>
            {result.questions.map((q, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                {q}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No questions generated.</Empty>
        )}
      </Section>

      <Section title={`Recent tweets (${result.tweets.length})`}>
        {result.tweets.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {result.tweets.map((t, i) => (
              <li
                key={i}
                style={{
                  background: PANEL_BG,
                  border: BORDER,
                  borderRadius: 4,
                  padding: 8,
                  fontSize: 12,
                  lineHeight: 1.4,
                }}
              >
                <div style={{ whiteSpace: "pre-wrap", color: "var(--slop-text)" }}>{t.text}</div>
                <div style={{ marginTop: 4, fontSize: 10, color: "var(--slop-text-muted)", display: "flex", gap: 8 }}>
                  {t.date ? <span>{t.date}</span> : null}
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" style={{ color: ACCENT, textDecoration: "none" }}>
                      open
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No tweets found.</Empty>
        )}
      </Section>

      <Section title={`Sources (${result.sources.length})`}>
        {result.sources.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {result.sources.map((s, i) => (
              <li key={i} style={{ fontSize: 12, lineHeight: 1.4 }}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: ACCENT, textDecoration: "none", fontWeight: 600 }}
                >
                  {s.title}
                </a>
                {s.snippet ? <div style={{ color: "var(--slop-text-muted)", fontSize: 11 }}>{s.snippet}</div> : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No sources cited.</Empty>
        )}
      </Section>
    </>
  );
};

const Section = ({ title, error, children }: { title: string; error?: string; children: React.ReactNode }) => (
  <section>
    <div
      style={{
        fontSize: 9,
        fontFamily: "var(--slop-font-display)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: ACCENT,
        marginBottom: 6,
      }}
    >
      {title}
    </div>
    {error ? (
      <div
        style={{
          padding: 8,
          border: "1px solid rgba(255,62,62,0.4)",
          background: "rgba(255,62,62,0.06)",
          borderRadius: 4,
          fontSize: 11,
          color: "#ff9a9a",
          marginBottom: 6,
        }}
      >
        {error}
      </div>
    ) : null}
    {children}
  </section>
);

const Prose = ({ text }: { text: string }) => (
  <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5, color: "var(--slop-text)" }}>{text}</div>
);

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 12, color: "var(--slop-text-muted)", fontStyle: "italic" }}>{children}</div>
);

const SocialLink = ({ label, href, text }: { label: string; href: string; text: string }) => (
  <a href={href} target="_blank" rel="noreferrer" style={{ color: ACCENT, textDecoration: "none" }}>
    <span style={{ opacity: 0.6, marginRight: 4 }}>{label}:</span>
    {text}
  </a>
);

function hrefFor(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes(".")) return `https://${raw}`;
  return raw;
}
