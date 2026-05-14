"use client";

// Big SLOP.COMPUTER ASCII watermark floated along the bottom of the
// viewport, just to the left of the trash can. Pure decoration —
// pointer-events: none so it never intercepts drags or clicks, and
// a low z-index so it sits behind all windows / icons.

const SLOP_ASCII = `███████╗██╗      ██████╗ ██████╗  ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗   ██╗████████╗███████╗██████╗
██╔════╝██║     ██╔═══██╗██╔══██╗██╔════╝██╔═══██╗████╗ ████║██╔══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗
███████╗██║     ██║   ██║██████╔╝██║     ██║   ██║██╔████╔██║██████╔╝██║   ██║   ██║   █████╗  ██████╔╝
╚════██║██║     ██║   ██║██╔═══╝ ██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██║   ██║   ██║   ██╔══╝  ██╔══██╗
███████║███████╗╚██████╔╝██║██╗  ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ╚██████╔╝   ██║   ███████╗██║  ██║
╚══════╝╚══════╝ ╚═════╝ ╚═╝╚═╝   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝      ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝`;

// Trash can geometry (TRASH_SIZE=88 + TRASH_MARGIN=24): the ASCII block
// ends just to the left of the trash with a small gap.
const RIGHT_OFFSET = 24 + 88 + 16;

export const SlopBackdrop = () => (
  <pre
    aria-hidden
    style={{
      position: "fixed",
      right: RIGHT_OFFSET,
      bottom: 72,
      width: "70vw",
      maxWidth: "70vw",
      margin: 0,
      padding: 0,
      pointerEvents: "none",
      userSelect: "none",
      zIndex: 0, // behind icons (z=1), trash (z=50), and windows — pure backdrop
      // 70vw / ~98 cols / ~0.6 em per monospace char → ~1.19vw font-size.
      // Clamp keeps it readable on very small or very large viewports.
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "clamp(4px, 1.18vw, 16px)",
      lineHeight: 1,
      letterSpacing: 0,
      whiteSpace: "pre",
      color: "var(--slop-magenta, #ff3ec9)",
      opacity: 0.18,
      textShadow: "0 0 6px rgba(255,62,201,0.25)",
      overflow: "hidden",
    }}
  >
    {SLOP_ASCII}
  </pre>
);

export default SlopBackdrop;
