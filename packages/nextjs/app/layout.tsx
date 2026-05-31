import { Silkscreen } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import type { Viewport } from "next";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import { getMetadata } from "~~/utils/scaffold-eth/getMetadata";

const silkscreen = Silkscreen({
  variable: "--font-silkscreen",
  weight: "400",
  subsets: ["latin"],
});

export const metadata = getMetadata({
  title: "Slop Computer",
  description: "Live, interactive desktop podcast at live.slop.computer",
});

// Phones/tablets aren't a real entry path for slop — but rather than
// build a full mobile UI, we just zoom the desktop out to ~55% so the
// whole thing fits on a small screen. With width=device-width the
// browser reports the (wider) layout viewport, so the desktop lays
// itself out larger and gets scaled down to fit. Desktop browsers
// ignore the viewport meta, so this is naturally tablet/phone-only.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 0.55,
};

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="en" suppressHydrationWarning data-theme="dark" className={silkscreen.variable}>
      <head>
        {/* The pointer cursor is the very first thing the user looks for —
            without it the page reads as broken. Preload it before any other
            asset using as="fetch" (NOT as="image") because useCursorSvg
            fetches the SVG as TEXT to inline its markup; preload entries
            only match when the destination matches. fetchPriority="high"
            puts it ahead of the JS bundle in the connection queue.
            The grab/grabbing/text cursors don't matter for first paint but
            we still preload them at "low" so they're warm in cache before
            the user hovers a draggable or focuses an input — otherwise the
            cursor visibly flickers on first interaction while the SVG
            downloads. Low priority keeps them out of the way of the JS
            bundle and the pointer's high-priority slot. */}
        <link
          rel="preload"
          as="fetch"
          crossOrigin="anonymous"
          fetchPriority="high"
          href="/cursors/six_finger_pointer_exact_band_masks_no_bleed.svg"
        />
        <link
          rel="preload"
          as="fetch"
          crossOrigin="anonymous"
          fetchPriority="low"
          href="/cursors/six_finger_open_grab_dynamic_bands.svg"
        />
        <link
          rel="preload"
          as="fetch"
          crossOrigin="anonymous"
          fetchPriority="low"
          href="/cursors/six_finger_grabbing_fist_dynamic_bands_clean.svg"
        />
        <link
          rel="preload"
          as="fetch"
          crossOrigin="anonymous"
          fetchPriority="low"
          href="/cursors/text_cursor_ibeam_clean.svg"
        />
      </head>
      <body>
        <ThemeProvider forcedTheme="dark">
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldEthApp;
