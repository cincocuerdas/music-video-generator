# SmolVLM Scene Audit

This repository includes an optional visual QA helper for generated images and videos:

- `scripts/dev-tools/audit_scene_with_smolvlm.py`
- `scripts/dev-tools/audit_binary_with_smolvlm.py`

It uses the public Hugging Face model:

- `HuggingFaceTB/SmolVLM2-500M-Video-Instruct`
- model page: `https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct`

## Purpose

Use this tool as a secondary verifier for generated outputs.

Good use cases:

- confirm whether an image really shows the intended subject
- flag text/signage failures
- flag likely anatomy or crowd artifacts
- enrich manual QA and quality tracking

Do **not** use it to replace:

- lyric analysis
- provider routing
- generation itself

The binary helper is usually more reliable than the full audit helper when you only need a few scene checks such as:

- `Is there a wolf?`
- `Is the main subject human?`
- `Is there readable text?`

## Install

This tool is optional. It is intentionally isolated from the main pipeline.

From repo root:

```powershell
pip install -r scripts/dev-tools/requirements-smolvlm.txt
```

## Usage

### Dry run

Safe validation without loading the model:

```powershell
python scripts/dev-tools/audit_scene_with_smolvlm.py `
  output/audit/p3_targeted/gemini_scene_2.jpg `
  --expected-prompt "A lone wolf on a jagged cliff, howling at the moon" `
  --scene-class animal_subject `
  --provider gemini `
  --dry-run
```

### Image audit

```powershell
python scripts/dev-tools/audit_scene_with_smolvlm.py `
  output/audit/p3_targeted/project_f8ad2090-95a7-4672-97f5-050ee5b2aadf_gemini_scene_2.jpg `
  --expected-prompt "A lone wolf on a jagged cliff, howling at the moon" `
  --scene-class animal_subject `
  --provider gemini
```

### Video audit

```powershell
python scripts/dev-tools/audit_scene_with_smolvlm.py `
  output/audit/p3_targeted/video.mp4 `
  --expected-prompt "Crowd surging past neon signs and graffiti banners" `
  --scene-class crowd `
  --provider gemini `
  --media-type video
```

### Binary scene audit

```powershell
python scripts/dev-tools/audit_binary_with_smolvlm.py `
  output/audit/p3_targeted/gemini_scene_2.jpg `
  --question "Is there a wolf as the main subject?" `
  --question "Is the main subject human?" `
  --question "Is there readable text in the image?" `
  --media-type image
```

## Output

Default output directory:

- `output/audit/smolvlm/`

The tool writes JSON with:

- input metadata
- model/runtime metadata
- raw response
- parsed audit JSON

Main audit fields:

- `primarySubject`
- `sceneMatch`
- `peopleEstimate`
- `textLegibility`
- `artifactFlags`
- `recommendedFailureTags`
- `confidence`
- `notes`

Binary audit fields:

- `answers[].question`
- `answers[].answer` (`yes|no|unclear`)
- `answers[].confidence`
- `answers[].evidence`

The binary helper asks for `A1/A2/A3...` answer lines rather than `Q1/Q2/Q3...` because small VLMs tend to echo the prompt format if question and answer labels are identical.

The model is asked for a short `key:value` response first because it is more reliable than nested JSON on small VLMs. The script still accepts strict JSON if the model returns it.

## Expected Workflow

Recommended usage:

1. Generate video or scene images as usual.
2. Prefer scene images or short scene-level clips, not a full multi-scene final video, when your expected prompt describes a single scene.
3. Run this tool only on suspect scenes or benchmark sets.
4. If the model returns prose instead of strict JSON, the script falls back to a low-confidence structured audit and marks the run as `degraded`.
5. Review `rawResponse` when the fallback parser is used.
6. Compare `recommendedFailureTags` against `docs/generation-failure-taxonomy.md`.
7. Use the result as QA evidence, not as a single-source truth.

## Operational Notes

- The script lazy-loads heavy dependencies. `--help` and `--dry-run` work without `torch` or `transformers`.
- Video mode requires `decord`.
- Installing `torchcodec` is optional but recommended if you plan to audit videos frequently, because the default fallback decoder in `torchvision` is deprecated.
- If the model returns malformed JSON, the script saves the raw response and emits a `degraded` structured fallback instead of crashing.
- If the model ignores the requested format, the script tries three parsers in order:
  1. strict JSON
  2. flat `key:value` lines
  3. low-confidence prose fallback
- If you pass a short filename such as `output/audit/p3_targeted/gemini_scene_2.jpg`, the script will try to resolve the matching file inside that folder.
