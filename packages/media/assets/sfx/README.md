# Sound effects (auto-enhance)

Files here are mixed into clips when a video has **Smart SFX** enabled. Each
`<name>.mp3` maps to a sound the LLM can place (`whoosh`, `boom`, `faaaaa`).

- `whoosh.mp3`, `boom.mp3` — synthesized, royalty-free (generated with ffmpeg).
- `faaaaa.mp3` — **you provide this.** Drop your own `faaaaa.mp3` here and commit
  it. It's intentionally not bundled: it's a meme sound and can't be shipped for
  licensing reasons. If the file is absent, `faaaaa` cues are simply skipped
  (the rest still work).

Keep them short (< ~1s) and pre-trimmed. A missing file for any cue is skipped
gracefully — it never breaks a render.
