import { Silkscreen } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
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
  title: "Slop..Computer",
  description: "Live, interactive desktop podcast at live.slop.computer",
});

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning data-theme="dark" className={silkscreen.variable}>
      <head>
        {/* Cursor SVGs are large (the open-grab one is ~3.7 MB because it
            embeds a JPEG). Preload all four on initial HTML so they're in
            cache before the user first hovers a draggable surface and we
            don't show a stale cursor while the SVG downloads. */}
        <link rel="preload" as="image" href="/cursors/six_finger_pointer_exact_band_masks_no_bleed.svg" />
        <link rel="preload" as="image" href="/cursors/six_finger_open_grab_dynamic_bands.svg" />
        <link rel="preload" as="image" href="/cursors/six_finger_grabbing_fist_dynamic_bands_clean.svg" />
        <link rel="preload" as="image" href="/cursors/text_cursor_ibeam_clean.svg" />
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
