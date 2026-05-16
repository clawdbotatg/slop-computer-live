# @slop/icon-gen

Slop desktop icon generator. Uses OpenAI `gpt-image-1` (image edit) with a
single style reference (`style-ref.png`) so every icon shares the same
chunky Mac OS 9 / cyberdelic palette.

## Setup (once)

```bash
cp packages/icon-gen/.env.example packages/icon-gen/.env
# edit .env and paste your OPENAI_API_KEY
yarn install      # picks up the workspace
```

## Generate ONE icon for a new app

```bash
# from repo root:
yarn icon:add <kebab-name> "<prompt describing the subject>"

# example:
yarn icon:add paint "An artist's paint-palette icon with a paintbrush sticking out."
```

That writes the result to **two** places:

- `packages/icon-gen/out/icons/<name>.png` — local cache
- `packages/nextjs/public/icons/<name>.png` — what the relay's apps catalog
  serves at `/icons/<name>.png`

It also appends `{ name, prompt }` to `icons.json` so the batch regenerator
stays in sync.

After generating, wire the icon into a new app entry in
`packages/relay/src/index.ts` `DEFAULT_APPS`:

```ts
{
  id: "<name>",
  label: "<Label>",
  icon: "/icons/<name>.png",
  kind: "<kind>",   // or `url: "..."` for a browser-style app
},
```

## Regenerate the whole set

```bash
yarn icon:gen
```

Reads `icons.json`, skips icons that already exist in `out/icons/`, then
composites a sheet at `out/sheet.png` with a manifest.

## Style consistency

- The single style ref is `style-ref.png` — DON'T regenerate it lightly,
  every other icon's look is locked to it.
- The shared style hint lives in `icons.json` (`styleHint` field).
- The bootstrap prompt (`bootstrapPrompt`) is only used if `style-ref.png`
  is missing — it generates a new hero from scratch.
