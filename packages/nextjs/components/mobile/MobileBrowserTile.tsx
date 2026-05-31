"use client";

// View-only browser preview for the mobile clip stage. Renders an
// <iframe> of the URL the room has open in a SharedBrowser window —
// NOT a stream of the desktop's screenshot pipeline. That means:
//
//   * Stateless apps (abi.ninja, nifty-ink, demos) render correctly.
//   * Stateful apps will load with this spectator's own cookies/
//     session, not the desktop user's — so the room and the clip
//     might briefly differ until the page settles.
//
// Future: subscribe to the same browser-host WS the SharedBrowser
// component does and render the JPEG frames so the clip matches the
// room pixel-for-pixel (including impersonated wallet state). Iframe
// is the cheap path to "shared browser shows up on mobile."

export type MobileBrowserTileProps = {
  url: string;
  /** Bottom-right corner gets a small "browser" tag so a clip viewer
   *  can tell this tile is a webpage and not a screen share or
   *  recorded video. */
  showBadge?: boolean;
};

export const MobileBrowserTile = ({ url, showBadge = true }: MobileBrowserTileProps) => {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}>
      <iframe
        src={url}
        title="shared browser"
        // `sandbox` without `allow-same-origin` would block most apps
        // (no localStorage, no cookies) — keep it permissive so the
        // page renders like it does in a normal tab.
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        // No pointer-events: a clip recorder shouldn't accidentally
        // scroll or click into the embedded site. The clip captures
        // the visual frame, not interactions.
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: 0,
          pointerEvents: "none",
          background: "#fff",
        }}
      />
      {showBadge ? (
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            padding: "2px 6px",
            background: "rgba(6,8,24,0.78)",
            border: "1px solid rgba(63,207,255,0.40)",
            borderRadius: 3,
            fontFamily: "var(--slop-font-display)",
            fontSize: 9,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            color: "var(--slop-cyan, #3fcfff)",
            pointerEvents: "none",
            maxWidth: "60%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            zIndex: 3,
          }}
          title={url}
        >
          {hostFromUrl(url)}
        </div>
      ) : null}
    </div>
  );
};

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "browser";
  }
}

export default MobileBrowserTile;
