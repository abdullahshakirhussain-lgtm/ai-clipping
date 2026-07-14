# ClipFactory Poster (Chrome extension)

Bridges the ClipFactory dashboard to the accounts you're already logged into in
Chrome, so a queued clip posts to YouTube (TikTok/Facebook next) in ~3 clicks —
without any platform API.

## How it works

```
Distribution page ──window.postMessage──▶ bridge.js ──chrome.runtime──▶ background.js
                                                                            │
                                          downloads clip + opens YouTube ◀──┘
YouTube Studio ──content-youtube.js fills title/description, grabs the URL──▶ background
background ──result──▶ bridge ──postMessage──▶ dashboard marks the job posted
```

The page never sees a `chrome` API or the extension ID; it only posts/receives
`window` messages. The dashboard holds the API session and makes all API calls.

## Build

```
pnpm --filter @clipfactory/extension build
```

Outputs an unpacked extension to `apps/extension/dist/`.

## Load in Chrome

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/dist`.
3. Open your ClipFactory **Distribution** page — it should show **Extension
   connected ✓**.

If your dashboard runs on a domain other than `localhost:3000` or the current
Railway URL, add it to `content_scripts[0].matches` in `public/manifest.json`
and rebuild.

## Use

1. Distribute kept clips, pick a YouTube account, open its queue.
2. Click **Post to YouTube** on a clip. The extension downloads the clip and
   opens YouTube's upload page.
3. Pick the downloaded clip in the file dialog. That's the only manual step.
4. The extension fills the title + description, sets "not made for kids",
   advances the wizard, sets visibility to **Public**, clicks **Publish**,
   captures the published URL, and marks the job posted in the dashboard.

If a YouTube Studio selector has drifted, auto-finish stops and the status tells
you — just complete the last steps by hand; the extension still captures the URL.

## Caveats

- YouTube Studio's DOM changes over time; if auto-fill stops working, update the
  selectors in `src/content-youtube.ts`.
- TikTok and Facebook content scripts land in later phases (X4/X5).
