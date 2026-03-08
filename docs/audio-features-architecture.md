# Audio Features Architecture

This document defines a pragmatic audio-intelligence module that improves scene timing and semantic guidance without replacing the current lyrics pipeline.

The goal is to capture useful musical structure and energy information in a way that is commercially safe, operationally simple, and incremental.

## Objectives

1. Produce a per-project `audio_features.json` artifact.
2. Improve automatic scene timing and section awareness.
3. Improve lyrics/transcription robustness by optionally using vocal-isolated audio.
4. Keep the current pipeline as the source of truth for semantic lyrics analysis.
5. Avoid any dependency on non-commercial datasets or copied implementations.

## Non-Goals

- Full DAW/editor functionality.
- Proprietary stem separation parity with products like Moises.
- Training new large audio models.
- Replacing the current `analyze_lyrics.py` semantic pipeline.

## Proposed Module Boundary

### New Backend Service

`AudioFeaturesService`

Responsibilities:
- orchestrate extraction of derived audio signals
- load and persist `audio_features.json`
- expose typed accessors for downstream modules
- remain optional/fail-safe

### New Python Scripts

1. `scripts/extract_audio_features.py`
- reads canonical project audio
- computes BPM, beat frames, section hints, energy curve, loudness envelope, spectral centroid/rolloff, vocal activity estimate
- writes `output/audio_features/project_<id>.json`

2. `scripts/extract_vocal_proxy.py`
- optional lightweight vocal-isolation pre-pass for transcription only
- can start with heuristic or open model with commercial-safe license
- writes `output/audio_features/project_<id>_vocal_proxy.wav`

### Existing Pipeline Touchpoints

- `TRANSCRIPTION`
  - optionally uses vocal proxy instead of raw mix
- `ANALYZE_LYRICS`
  - reads `audio_features.json` when present
  - enriches prompt with section and energy context
- `RENDER_VIDEO`
  - can use beat/time landmarks for cut alignment in a later phase

## Output Schema

Suggested artifact:

```json
{
  "projectId": "uuid",
  "version": 1,
  "audioPath": "output/audio/...",
  "durationSec": 236.12,
  "sampleRate": 44100,
  "tempoBpm": 96.4,
  "timeSignature": "4/4",
  "beats": [
    { "timeSec": 0.00, "strength": 0.71 },
    { "timeSec": 0.62, "strength": 0.83 }
  ],
  "downbeats": [0.00, 2.48, 4.96],
  "sections": [
    { "label": "intro", "startSec": 0.00, "endSec": 14.20, "confidence": 0.64 },
    { "label": "verse", "startSec": 14.20, "endSec": 38.50, "confidence": 0.72 },
    { "label": "chorus", "startSec": 38.50, "endSec": 59.10, "confidence": 0.76 }
  ],
  "energyCurve": [
    { "timeSec": 0.00, "energy": 0.22 },
    { "timeSec": 5.00, "energy": 0.41 }
  ],
  "loudnessCurve": [
    { "timeSec": 0.00, "db": -18.2 },
    { "timeSec": 5.00, "db": -11.6 }
  ],
  "vocalPresenceCurve": [
    { "timeSec": 0.00, "presence": 0.03 },
    { "timeSec": 5.00, "presence": 0.84 }
  ],
  "spectral": {
    "centroidMean": 2140.8,
    "rolloffMean": 6314.4,
    "bassEnergyMean": 0.38,
    "trebleEnergyMean": 0.21
  },
  "moodHints": {
    "energy": "medium_high",
    "brightness": "warm",
    "density": "busy"
  },
  "vocalProxy": {
    "enabled": true,
    "path": "output/audio_features/project_<id>_vocal_proxy.wav",
    "method": "demucs-lite",
    "status": "success"
  },
  "status": "success",
  "degraded": false,
  "degradedReasons": []
}
```

## TypeScript Types

Create a shared type like:

- `src/modules/audio/types/audio-features.types.ts`

Core interfaces:
- `AudioFeaturesResult`
- `BeatPoint`
- `SectionMarker`
- `CurvePoint`
- `MoodHints`
- `VocalProxyMeta`

## Pipeline Integration Plan

### Phase 1: Read-Only Enrichment

- new job type: `EXTRACT_AUDIO_FEATURES`
- trigger after `YOUTUBE_DOWNLOAD` or when local audio is already available
- do not block the rest of the pipeline if extraction fails
- store result path on project/job metadata

Order proposal:
- `YOUTUBE_DOWNLOAD` -> `EXTRACT_AUDIO_FEATURES` -> `TRANSCRIPTION` -> `ANALYZE_LYRICS` -> `GENERATE_IMAGES` -> `RENDER_VIDEO`

For `lyrics-only` source mode:
- skip `YOUTUBE_DOWNLOAD`
- skip `EXTRACT_AUDIO_FEATURES` unless an audio file exists

### Phase 2: Transcription Assist

- if `vocalProxy.enabled=true` and extraction succeeded, feed proxy audio into transcription
- keep raw audio as fallback
- compare WER / segment count / confidence before making it default

### Phase 3: Edit-Aware Rendering

- use `beats`, `downbeats`, and `sections` to nudge scene boundaries
- align cuts/transitions around musical landmarks
- keep visual semantic continuity as the stronger rule

## Minimal Python Stack

Commercially safer starting stack:
- `librosa` for tempo, beat tracking, spectral features, RMS/energy
- `soundfile` / `ffmpeg` for I/O
- optional commercial-safe stem/vocal model later, only after license review

Initial implementation should avoid any dataset or model with non-commercial restrictions.

## Failure Model

This module must be fail-safe.

If extraction fails:
- pipeline continues normally
- artifact writes:
  - `status=degraded` or `failed`
  - `degradedReasons=[...]`
- downstream consumers treat absence of `audio_features.json` as optional

## Concurrency & Runtime Constraints

This is a medium-weight CPU job, not a GPU-critical job by default.

Suggested caps:
- local:
  - `EXTRACT_AUDIO_FEATURES=1`
- cloud:
  - `EXTRACT_AUDIO_FEATURES=2-4` depending on CPU

If vocal isolation is introduced with a heavy model:
- treat it as a separate heavy cap or queue

## Metrics To Track

Project-level:
- extraction success rate
- extraction latency p50/p95
- fraction of runs with usable section markers
- fraction of runs where vocal proxy was used

Quality impact:
- transcription segment count delta with and without vocal proxy
- degraded rate before/after audio features
- usable_as_is rate before/after beat/section-aware editing

## Acceptance Criteria

### Phase 1
- `audio_features.json` generated for projects with audio
- pipeline stays green if extraction fails
- `analyze_lyrics.py` can read and use section/energy hints optionally

### Phase 2
- vocal proxy demonstrably improves transcription quality on a test batch
- no material throughput regression beyond agreed budget

### Phase 3
- beat-aware edits improve perceived timing on a reviewed batch
- no increase in continuity failures

## Suggested Files To Add Later

- `src/modules/audio/audio.module.ts`
- `src/modules/audio/audio-features.service.ts`
- `src/modules/audio/types/audio-features.types.ts`
- `src/modules/jobs/processors/audio-features.processor.ts`
- `scripts/extract_audio_features.py`
- `scripts/extract_vocal_proxy.py`
- `scripts/dev-tools/test_audio_features_contract.py`

## Recommendation

Build this in three phases.

Do not start with source separation parity.
Start with:
- tempo
- beats
- sections
- energy/loudness curves

That gives immediate product value with low legal and operational risk.
