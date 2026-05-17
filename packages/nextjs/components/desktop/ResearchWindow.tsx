"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingBar } from "~~/components/ui";

// Indeterminate bars on these calls "fluttered" — they reset every cycle
// which felt twitchy. Instead we drive the bar with a fixed assumed
// duration. Calls usually finish before 95% and the bar disappears; if a
// call runs longer the bar just holds at 95% rather than overflowing.
const LOOKUP_ASSUMED_MS = 15_000;
const RESEARCH_ASSUMED_MS = 100_000;
const PROGRESS_TICK_MS = 100;
const PROGRESS_CAP = 95;

function useTimedProgress(active: boolean, durationMs: number): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }
    const startedAt = Date.now();
    setProgress(0);
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const pct = Math.min(PROGRESS_CAP, (elapsed / durationMs) * 100);
      setProgress(pct);
    }, PROGRESS_TICK_MS);
    return () => clearInterval(id);
  }, [active, durationMs]);
  return progress;
}

// Guest research dossier. Any authenticated peer can use it. Local
// state — no mesh sync, so each viewer's form/output is independent.
// In practice the host opens it on stream so the room can read along.
//
// Two-phase flow:
//   1. "lookup" — single freeform "twitter/x or name" box. POSTs to
//      /v1/guest-lookup, which does ONE Claude+web_search call to
//      resolve the input into a best-guess identity card.
//   2. "form" — the full editable form, prefilled from the lookup
//      result. Hitting Research kicks off /v1/guest-research, which
//      runs vanilla + web-researched Claude calls in parallel.

const RELAY_HTTP_URL = process.env.NEXT_PUBLIC_RELAY_HTTP_URL ?? "http://localhost:8080";

type Socials = {
  twitter: string;
  github: string;
  linkedin: string;
  website: string;
  other: string;
};

type TweetSnippet = {
  text: string;
  url?: string;
  date?: string;
};

type ResearchSource = {
  title: string;
  url: string;
  snippet?: string;
};

type ResearchResult = {
  query: { name: string; socials: Partial<Socials>; notes?: string };
  vanilla: string;
  researched: string;
  questions: string[];
  tweets: TweetSnippet[];
  sources: ResearchSource[];
  errors: { vanilla?: string; researched?: string };
};

type LookupResult = {
  name: string;
  socials: Partial<Socials>;
  notes: string;
  error?: string;
};

type Phase = "lookup" | "form";

const PANEL_BG = "#0a061a";
const BORDER = "1px solid rgba(255,62,201,0.25)";
const ACCENT = "var(--slop-magenta, #ff3ec9)";

const EMPTY_SOCIALS: Socials = { twitter: "", github: "", linkedin: "", website: "", other: "" };

export const ResearchWindow = () => {
  const [phase, setPhase] = useState<Phase>("lookup");

  // Phase 1 state
  const [lookupQuery, setLookupQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Phase 2 state (form + research output)
  const [name, setName] = useState("");
  const [socials, setSocials] = useState<Socials>(EMPTY_SOCIALS);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResearchResult | null>(null);

  const setSocialField = (k: keyof Socials, v: string) => setSocials(s => ({ ...s, [k]: v }));

  const runLookup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = lookupQuery.trim();
      if (!q) return;
      setLooking(true);
      setLookupError(null);
      try {
        const res = await fetch(`${RELAY_HTTP_URL}/v1/guest-lookup`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (res.status === 401) setLookupError("You're not signed in. Reload and join again.");
          else setLookupError(`Relay error ${res.status}: ${body.error ?? "unknown"}`);
          return;
        }
        const data = (await res.json()) as LookupResult;
        if (data.error) {
          setLookupError(data.error);
          return;
        }
        // Fall back to the raw query as the name if the model came up
        // empty — the host can edit it before hitting Research.
        setName(data.name || q);
        setSocials({
          twitter: data.socials.twitter ?? "",
          github: data.socials.github ?? "",
          linkedin: data.socials.linkedin ?? "",
          website: data.socials.website ?? "",
          other: data.socials.other ?? "",
        });
        setNotes(data.notes ?? "");
        setPhase("form");
      } catch (err) {
        setLookupError(`Network error: ${String(err).slice(0, 200)}`);
      } finally {
        setLooking(false);
      }
    },
    [lookupQuery],
  );

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      if (!trimmedName) return;
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const res = await fetch(`${RELAY_HTTP_URL}/v1/guest-research`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            socials,
            notes: notes.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (res.status === 401) {
            setError("You're not signed in. Reload and join again.");
          } else {
            setError(`Relay error ${res.status}: ${body.error ?? "unknown"}`);
          }
          return;
        }
        const data = (await res.json()) as ResearchResult;
        setResult(data);
      } catch (err) {
        setError(`Network error: ${String(err).slice(0, 200)}`);
      } finally {
        setLoading(false);
      }
    },
    [name, socials, notes],
  );

  const startOver = () => {
    setPhase("lookup");
    setLookupQuery("");
    setLookupError(null);
    setName("");
    setSocials(EMPTY_SOCIALS);
    setNotes("");
    setResult(null);
    setError(null);
  };

  const researchProgress = useTimedProgress(loading, RESEARCH_ASSUMED_MS);

  if (phase === "lookup") {
    return (
      <LookupPhase
        query={lookupQuery}
        setQuery={setLookupQuery}
        onSubmit={runLookup}
        loading={looking}
        error={lookupError}
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
      {/* Form */}
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
          value={socials.twitter}
          onChange={v => setSocialField("twitter", v)}
          placeholder="@vitalikbuterin"
        />
        <LabeledInput
          label="GitHub"
          value={socials.github}
          onChange={v => setSocialField("github", v)}
          placeholder="vbuterin"
        />
        <LabeledInput
          label="LinkedIn"
          value={socials.linkedin}
          onChange={v => setSocialField("linkedin", v)}
          placeholder="profile url or handle"
        />
        <LabeledInput
          label="Website"
          value={socials.website}
          onChange={v => setSocialField("website", v)}
          placeholder="https://vitalik.ca"
        />
        <LabeledInput
          label="Other"
          value={socials.other}
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
              cursor: "pointer",
            }}
          >
            Start over
          </button>
          <button
            type="submit"
            disabled={!name.trim() || loading}
            style={{
              padding: "6px 14px",
              fontSize: 10,
              fontFamily: "var(--slop-font-display)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              background: !name.trim() || loading ? "rgba(255,62,201,0.25)" : ACCENT,
              color: "#06030d",
              border: "none",
              borderRadius: 4,
              cursor: !name.trim() || loading ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {loading ? "Researching…" : "Research"}
          </button>
        </div>
      </form>

      {/* Output */}
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

        {!result && !error && !loading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--slop-text-muted)", fontSize: 12 }}>
            Fill in the guest&apos;s name and any socials, then hit Research. Takes ~10–30 seconds.
          </div>
        ) : null}

        {loading ? (
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
            <div>vanilla knowledge + web research running in parallel — usually a minute or two</div>
          </div>
        ) : null}

        {result ? <ResultView result={result} /> : null}
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
  error: string | null;
};

const LookupPhase = ({ query, setQuery, onSubmit, loading, error }: LookupPhaseProps) => {
  const progress = useTimedProgress(loading, LOOKUP_ASSUMED_MS);
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
          <div style={{ display: "flex", justifyContent: "center", marginTop: 4 }}>
            <LoadingBar cells={16} progress={progress} caption="looking up" />
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
          Resolves to a name, socials, and a one-line identity sketch. You can edit everything before going deeper.
        </div>
      </form>
    </div>
  );
};

const ResultView = ({ result }: { result: ResearchResult }) => {
  const handle = result.query.socials.twitter?.replace(/^@/, "");
  return (
    <>
      {/* Header: name + socials */}
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
