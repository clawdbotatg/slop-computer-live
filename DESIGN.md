# Slop Platinum — design system

The single visual language for slop.computer and live.slop.computer. Both repos copy this file and reference the same tokens. Forks should keep the system but swap the accent.

## Spirit

Mac OS 9 Platinum, but dark. Sharp edges, beveled chrome, charcoal panels. One accent colour: hot magenta (the "slop" pink). The whole site should feel like a working operating system from 1999 that someone reskinned at midnight.

## Tokens

| Token                    | Value                                |
|--------------------------|--------------------------------------|
| --slop-bg                | #1a1a1a                              |
| --slop-panel             | #262626                              |
| --slop-panel-light       | #333333                              |
| --slop-bevel-light       | #4a4a4a                              |
| --slop-bevel-dark        | #0d0d0d                              |
| --slop-text              | #e8e8e8                              |
| --slop-text-muted        | #9a9a9a                              |
| --slop-accent            | #ff00aa                              |
| --slop-accent-active     | #ff66cc                              |
| --slop-live              | #ff2255                              |
| --slop-titlebar          | linear-gradient(#3a3a3a, #2a2a2a)    |
| --slop-titlebar-active   | linear-gradient(#5a004a, #2a0020)    |

## Type

- Headings: Chicago, ChicagoFLF, system fallback. ALL CAPS for window titles.
- Body: Geneva, SF Mono, system mono fallback. 13px default.
- Numerics + Ethereum addresses: mono.

Self-host the Chicago and Geneva-style webfonts in /public/fonts so the site renders identically off Vercel, IPFS, and ENS.

## Chrome

Every panel, window, and button uses a 1px bevel:

```
border-top:    1px solid var(--slop-bevel-light);
border-left:   1px solid var(--slop-bevel-light);
border-right:  1px solid var(--slop-bevel-dark);
border-bottom: 1px solid var(--slop-bevel-dark);
```

Pressed/inset state flips light and dark borders. No border-radius anywhere. No box-shadows on chrome.

## Components

All components live in a copy-pasted `components/ui/` folder in BOTH repos (no shared package — keeps each repo independently forkable).

- Window — title bar (close/minimize/zoom dots, classic Mac left-aligned), content well, 12px resize grip in bottom-right
- Button — outset bevel; :active flips to inset; primary variant uses --slop-accent text
- TextField — 1px inset bevel, mono font
- MenuBar — fixed top of viewport on the desktop; "Slop", "File", "Live", "Wallet" menus
- Bevel — base primitive everything else composes from
- LivePulse — 8px circle in --slop-live, pulses 1s on/off when isLive
- Cursor — labelled remote cursor (handle or ENS), 1px black drop-shadow only here, smoothed at the receive end

## What NOT to do

- No rounded corners
- No drop shadows on chrome (cursors are the only exception)
- No emoji icons — use 1-bit pixel-style icons or simple unicode glyphs (▾ ◆ ◀ ●)
- No animations except the live pulse and cursor interpolation
- No third-party CSS frameworks beyond what SE2 ships

## Forkability

Forks should:
1. Change --slop-accent and --slop-titlebar-active to their own colour
2. Replace "Slop" wordmark in the menu bar
3. Keep the rest of the system so the family of slop-style podcast platforms is visually consistent
