# Summarize Integration

We integrated `@steipete/summarize` as a narrow ingest utility, not as a core pipeline dependency.

## Why this integration exists

- Extract gist from URLs, YouTube links, podcast pages, and files.
- Produce structured JSON artifacts under `output/summaries/`.
- Keep the main lyrics/image/video pipeline unchanged.

## Why `agent-scripts` was not integrated

- There is no stable `agent-scripts` package on npm to pin and audit.
- Treat that repo as a reference library of patterns, not as a runtime dependency for this app.

## Usage

Extract-only mode (safe default, no LLM key required):

```powershell
npm run summarize:source -- https://example.com
```

Full summary mode (requires supported provider credentials such as `GEMINI_API_KEY`):

```powershell
npm run summarize:source -- https://youtu.be/dQw4w9WgXcQ --mode summary --model google/gemini-2.5-flash
```

Custom output path:

```powershell
npm run summarize:source -- https://example.com/report.pdf --out output/summaries/report.json
```

## Output contract

The wrapper writes JSON with this outer shape:

```json
{
  "tool": "@steipete/summarize",
  "mode": "extract",
  "input": "https://example.com",
  "model": null,
  "generatedAt": "2026-03-06T00:00:00.000Z",
  "stderr": null,
  "payload": {}
}
```

`payload` is the raw JSON emitted by `@steipete/summarize`.

## Constraints

- `@steipete/summarize` requires Node `>=22`.
- Our local runtime is Node `24.13.0`, so this is fine locally.
- If we ever want this in production or CI, the runtime must also be Node `22+`.

## Recommended use in this repo

- audit/triage URLs before importing them
- summarize source material for manual review
- enrich source preview UX
- optionally enrich `analyze_lyrics.py` for YouTube-backed projects with supplemental source context
- persist lightweight audit traces in `analysisResult`:
  - `_sourceContextUsed`
  - `_sourceContextSummarySnippet`
  - `_sourceContextMeta` (`title`, `siteName`, `transcriptSource`, `durationSeconds` when available)

## What this integration does not replace

- it does not replace the lyrics-analysis pipeline
- it does not run for `lyrics`-only projects
- it does not run for `audio`-only projects without a URL source
- no automatic summary generation inside project creation
- no dependency on `agent-scripts`
