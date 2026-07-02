"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingBar } from "~~/components/ui";
import type { PeerMeshState, ResearchResult, ResearchSocials } from "~~/hooks/usePeerMesh";
import { useSyncedScroll } from "~~/hooks/useSyncedScroll";
import { useRoomSlug } from "~~/lib/room-slug";

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
//
// The Corpus side panel is a mini-Notes embedded in this window:
// named docs of pasted source material (tweet threads, article text)
// that the relay tiles into the AI prompt on every Lookup/Research.
// Docs are shared state like notes (research-corpus.ts broadcasts the
// full list); the panel-open toggle is per-viewer, persisted locally.

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

const CORPUS_OPEN_KEY = "slop-research-corpus-open";
const CORPUS_SAVE_DEBOUNCE_MS = 400;

export const ResearchWindow = ({ mesh }: { mesh: PeerMeshState }) => {
  const rs = mesh.researchState;
  const lookupRunning = rs.job?.kind === "lookup";
  const researchRunning = rs.job?.kind === "research";
  const resultsRef = useRef<HTMLDivElement>(null);
  // Multiplayer scroll sync for the dossier results pane.
  const onScroll = useSyncedScroll(mesh, "research", resultsRef);

  // ---- Phase 1: lookup screen ---------------------------------------------
  // Local typing state for the freeform "name or @handle" input. Kept
  // local so spectators don't see keystrokes — only the submit
  // broadcasts. Pre-seeded from the shared state on mount so a
  // late-joiner sees what the room is currently asking about; when the
  // shared query is still empty, seed "@<slug>" instead — rooms are
  // named after the guest's Twitter handle, so that's almost always
  // the right first lookup (same spirit as the card/QR slug defaults).
  const slug = useRoomSlug();
  const [lookupQuery, setLookupQuery] = useState(() => rs.lookupQuery || `@${slug}`);
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

  // ---- Corpus panel toggle -------------------------------------------------
  // Per-viewer (NOT broadcast — a spectator peeking at the corpus
  // shouldn't yank it open on everyone's screen). Seeded from
  // localStorage in the initializer so it survives reloads.
  const [corpusOpen, setCorpusOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(CORPUS_OPEN_KEY) === "1";
  });
  useEffect(() => {
    if (corpusOpen) window.localStorage.setItem(CORPUS_OPEN_KEY, "1");
    else window.localStorage.removeItem(CORPUS_OPEN_KEY);
  }, [corpusOpen]);
  const corpusCount = mesh.researchCorpus.length;

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
  // host can tweak + re-research if needed. Either screen sits in the
  // left column of a row layout; the Corpus panel docks on the right.
  // The form screen stays inline JSX (not a child component like
  // LookupPhase) because it reads a dozen pieces of the local form
  // state above — and an inline component closure would remount (and
  // blur) the inputs on every parent render.
  const formScreen = (
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
            onClick={() => setCorpusOpen(o => !o)}
            style={{
              marginRight: "auto",
              padding: "6px 12px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              background: corpusOpen ? "rgba(255,62,201,0.15)" : "transparent",
              color: corpusOpen ? "var(--slop-text)" : "var(--slop-text-muted)",
              border: BORDER,
              borderRadius: 4,
              cursor: "pointer",
            }}
            title="source documents fed to the research AI as host-provided context"
          >
            📚 Corpus{corpusCount > 0 ? ` (${corpusCount})` : ""}
          </button>
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
            title={
              researchRunning ? "wait for the in-flight job to finish" : "clear the dossier + corpus and start over"
            }
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
        ref={resultsRef}
        onScroll={onScroll}
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
              vanilla knowledge + web research
              {corpusCount > 0 ? ` + ${corpusCount} corpus doc${corpusCount === 1 ? "" : "s"}` : ""}, then an episode
              preview — usually a minute or two
              {rs.job?.startedBy ? <> · started by {rs.job.startedBy}</> : null}
            </div>
          </div>
        ) : null}

        {rs.result ? <ResultView result={rs.result} /> : null}
      </div>
    </div>
  );

  const main =
    rs.phase === "idle" || rs.phase === "lookup-pending" ? (
      <LookupPhase
        query={lookupQuery}
        setQuery={setLookupQuery}
        onSubmit={runLookup}
        loading={lookupRunning}
        startedAt={lookupRunning ? rs.job!.startedAt : null}
        startedBy={lookupRunning ? rs.job!.startedBy : null}
        error={rs.error}
        corpusCount={corpusCount}
        corpusOpen={corpusOpen}
        onToggleCorpus={() => setCorpusOpen(o => !o)}
      />
    ) : (
      formScreen
    );

  return (
    <div style={{ display: "flex", height: "100%", background: "#06030d", overflow: "hidden" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{main}</div>
      {corpusOpen ? <CorpusPanel mesh={mesh} onClose={() => setCorpusOpen(false)} /> : null}
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
  corpusCount: number;
  corpusOpen: boolean;
  onToggleCorpus: () => void;
};

const LookupPhase = ({
  query,
  setQuery,
  onSubmit,
  loading,
  startedAt,
  startedBy,
  error,
  corpusCount,
  corpusOpen,
  onToggleCorpus,
}: LookupPhaseProps) => {
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
        <button
          type="button"
          onClick={onToggleCorpus}
          style={{
            padding: "6px 12px",
            fontSize: 10,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            background: corpusOpen ? "rgba(255,62,201,0.15)" : "transparent",
            color: corpusOpen ? "var(--slop-text)" : "var(--slop-text-muted)",
            border: BORDER,
            borderRadius: 4,
            cursor: "pointer",
          }}
          title="source documents fed to the lookup + research AI as host-provided context"
        >
          📚 Corpus{corpusCount > 0 ? ` (${corpusCount})` : ""}
        </button>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, marginTop: 4 }}>
            <LoadingBar cells={16} progress={progress} caption="looking up" />
            {corpusCount > 0 ? (
              <div style={{ fontSize: 10, color: "var(--slop-text-muted)" }}>
                reading {corpusCount} corpus doc{corpusCount === 1 ? "" : "s"} alongside web search
              </div>
            ) : null}
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

      <Section title="Socials desc · episode preview" error={result.errors.socialsDesc}>
        {result.socialsDesc ? <Prose text={result.socialsDesc} /> : <Empty>No episode preview generated.</Empty>}
      </Section>

      <Section title="Vanilla LLM knowledge" error={result.errors.vanilla}>
        {result.vanilla ? <Prose text={result.vanilla} /> : <Empty>No baseline available.</Empty>}
      </Section>

      <Section title="Researched description" error={result.errors.researched}>
        {result.researched ? <Prose text={result.researched} /> : <Empty>No research output.</Empty>}
      </Section>

      {result.themes && result.themes.length > 0 ? (
        <Section title={`Themes & trends (${result.themes.length})`}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {result.themes.map((t, i) => (
              <li key={i} style={{ fontSize: 13, lineHeight: 1.5, color: "var(--slop-text)" }}>
                <span style={{ color: ACCENT, marginRight: 6 }}>▲</span>
                {t}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

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

      <Section title={`Recent tweets (${result.tweets.length})`} error={result.errors.tweetCrawl}>
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
                  {t.kind === "retweet" ? (
                    <span style={{ color: ACCENT, fontWeight: 600 }}>RT{t.rtOf ? ` @${t.rtOf}` : ""}</span>
                  ) : t.kind === "quote" ? (
                    <span style={{ color: ACCENT, fontWeight: 600 }}>quote</span>
                  ) : null}
                  {t.date ? <span>{t.date}</span> : null}
                  {typeof t.likes === "number" ? (
                    <span>
                      ♥ {t.likes} · ⟳ {t.retweets ?? 0}
                    </span>
                  ) : null}
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

      {result.corpusDocs && result.corpusDocs.length > 0 ? (
        <Section title={`Corpus docs used (${result.corpusDocs.length})`}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {result.corpusDocs.map((d, i) => (
              <li key={i} style={{ fontSize: 12, lineHeight: 1.4 }}>
                📚 {d.name}
                <span style={{ color: "var(--slop-text-muted)", fontSize: 11 }}>
                  {" "}
                  · {d.chars.toLocaleString()} chars
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
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

// ---- Corpus panel -----------------------------------------------------------
// Mini-Notes embedded in the research window: named docs of pasted
// source material the relay tiles into the AI prompt. Same editor
// strategy as NotesWindow — local drafts for instant keystrokes,
// debounced corpus_update to the relay, echo suppression so our own
// broadcast doesn't clobber an in-flight edit. The name field and body
// textarea share one debounce (a save always carries both).

const corpusTitleFor = (doc: { name: string; text: string }): string => {
  if (doc.name.trim()) return doc.name.trim().slice(0, 60);
  const first = doc.text.split("\n")[0].trim();
  if (first) return first.slice(0, 60);
  return "untitled";
};

const CorpusPanel = ({ mesh, onClose }: { mesh: PeerMeshState; onClose: () => void }) => {
  const docs = mesh.researchCorpus;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");
  const lastSentRef = useRef<{ id: string; name: string; text: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Same pending-new dance as NotesWindow: snapshot known ids on "+ New",
  // select whichever id shows up in the next broadcast that isn't in it.
  const pendingNewRef = useRef<Set<string> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Default selection: the most-recently-updated doc.
  const sorted = useMemo(() => [...docs].sort((a, b) => b.updatedTs - a.updatedTs), [docs]);
  useEffect(() => {
    if (selectedId && docs.some(d => d.id === selectedId)) return;
    setSelectedId(sorted[0]?.id ?? null);
  }, [sorted, selectedId, docs]);

  useEffect(() => {
    const known = pendingNewRef.current;
    if (!known) return;
    const fresh = docs.find(d => !known.has(d.id));
    if (fresh) {
      pendingNewRef.current = null;
      setSelectedId(fresh.id);
    }
  }, [docs]);

  // Sync drafts with the selected doc's server copy, skipping the echo
  // of our own last save.
  const selected = docs.find(d => d.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) {
      setDraftName("");
      setDraftText("");
      return;
    }
    const last = lastSentRef.current;
    if (last && last.id === selected.id && last.name === selected.name && last.text === selected.text) return;
    setDraftName(selected.name);
    setDraftText(selected.text);
  }, [selected]);

  useEffect(() => {
    if (!selectedId) return;
    textareaRef.current?.focus();
  }, [selectedId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  const queueSave = (name: string, text: string) => {
    if (!selected) return;
    const id = selected.id;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      lastSentRef.current = { id, name, text };
      mesh.corpusUpdate(id, { name, text });
    }, CORPUS_SAVE_DEBOUNCE_MS);
  };

  const onNameChange = (v: string) => {
    setDraftName(v);
    queueSave(v, draftText);
  };
  const onTextChange = (v: string) => {
    setDraftText(v);
    queueSave(draftName, v);
  };

  const createDoc = () => {
    pendingNewRef.current = new Set(docs.map(d => d.id));
    mesh.corpusCreate(`Doc ${docs.length + 1}`);
  };

  const deleteSelected = () => {
    if (!selected) return;
    mesh.corpusDelete(selected.id);
  };

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--slop-border, #2a1d4a)",
        background: PANEL_BG,
        color: "var(--slop-text)",
        fontFamily: "var(--slop-font-body)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: ACCENT,
          }}
        >
          Corpus
        </span>
        <button
          type="button"
          onClick={createDoc}
          style={{
            marginLeft: "auto",
            padding: "2px 8px",
            fontSize: 10,
            fontFamily: "var(--slop-font-display)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            background: ACCENT,
            color: "#06030d",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          + New
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="close corpus panel"
          style={{
            background: "transparent",
            border: "1px solid var(--slop-border, #2a1d4a)",
            color: "var(--slop-text-muted)",
            borderRadius: 3,
            padding: "2px 6px",
            fontSize: 10,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      <div
        style={{
          fontSize: 10,
          color: "var(--slop-text-muted)",
          padding: "6px 8px",
          borderBottom: "1px solid var(--slop-border, #2a1d4a)",
          lineHeight: 1.4,
        }}
      >
        Paste source material — tweets, article text, notes. Every doc is fed to the AI on Lookup &amp; Research.
      </div>

      {docs.length > 0 ? (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            overflowY: "auto",
            maxHeight: "35%",
            flexShrink: 0,
            borderBottom: "1px solid var(--slop-border, #2a1d4a)",
          }}
        >
          {sorted.map(doc => {
            const isActive = doc.id === selectedId;
            return (
              <li key={doc.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(doc.id)}
                  style={{
                    width: "100%",
                    padding: "5px 8px",
                    textAlign: "left",
                    background: isActive ? "rgba(255,62,201,0.15)" : "transparent",
                    color: isActive ? "var(--slop-text)" : "var(--slop-text-muted)",
                    border: "none",
                    borderBottom: "1px solid var(--slop-border, #2a1d4a)",
                    fontSize: 11,
                    fontFamily: "var(--slop-font-body)",
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {corpusTitleFor(doc)}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {selected ? (
        <>
          <div style={{ display: "flex", gap: 4, padding: "6px 8px 0" }}>
            <input
              value={draftName}
              onChange={e => onNameChange(e.target.value)}
              placeholder="doc name"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                background: "#06030d",
                color: "var(--slop-text)",
                border: BORDER,
                borderRadius: 4,
                padding: "4px 6px",
                font: "inherit",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={deleteSelected}
              aria-label="delete doc"
              style={{
                background: "transparent",
                border: "1px solid var(--slop-border, #2a1d4a)",
                color: "var(--slop-text-muted)",
                borderRadius: 3,
                padding: "2px 6px",
                fontSize: 9,
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
            value={draftText}
            onChange={e => onTextChange(e.target.value)}
            placeholder="paste tweets, article text, bios, anything…"
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: 0,
              margin: 8,
              resize: "none",
              background: "#06030d",
              color: "var(--slop-text)",
              border: BORDER,
              borderRadius: 4,
              outline: "none",
              padding: 8,
              fontSize: 12,
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
            fontSize: 11,
            fontStyle: "italic",
            padding: 16,
            textAlign: "center",
          }}
        >
          No docs yet. Click &quot;+ New&quot; and paste source material.
        </div>
      )}
    </div>
  );
};
