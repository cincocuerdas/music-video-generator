# Quality Improvement Backlog

This backlog is driven by tracked evidence from:

- `docs/quality-tracking-template.csv`
- `docs/scene-quality-tracking-template.csv`
- `docs/generation-failure-taxonomy.md`

Decision rule:

- do not change generation rules for isolated failures
- only act when a pattern appears:
  - at least `3` times across `10` runs, or
  - at least `2` times in the same scene class with the same provider/model

Current sample summary (`run_001` to `run_006`):

- `prompt_conflicting_intent: 6`
- `quality_gate_missed_bad_output: 5`
- `environment_incoherence: 1`
- `prompt_under_specified: 1`

## B1. Reduce `prompt_conflicting_intent`

**Status:** Ready  
**Priority:** High  
**Trigger:** Already above intervention threshold (`6` hits in current sample)

### Problem

The generated prompt sometimes mixes incompatible scene intents, for example:

- object detail + portrait framing
- animal subject + human styling
- film noir + warm modern portrait language
- environment/effects scene + face-focus tokens

This causes the model to produce a visually coherent image that is still semantically wrong.

### Goal

Reduce semantic drift caused by prompt construction before the image model runs.

### Hypothesis

If prompt building enforces a single dominant scene intent and removes cross-intent contamination, then:

- fewer scenes will drift toward the wrong subject class
- fewer reruns will be needed
- visual review pass rate will improve without changing provider

### Proposed work

1. Add a prompt intent validator before final provider prompt emission.
2. Define incompatible token groups, for example:
   - `portrait_human` tokens cannot coexist with `animal_subject`
   - `portrait_human` tokens cannot coexist with `effect_scene`
   - `object_detail` cannot silently inherit `face focus`
3. Add style dominance rules for styles that are easy to dilute:
   - `film noir`
   - any future stylized preset with strong visual constraints
4. Log the final resolved archetype and removed token groups for each scene.
5. Add a small regression set of "wrong subject class" prompts and assert final prompt shape.

### Metrics

Primary:

- reduce `prompt_conflicting_intent` from current baseline to `< 3` occurrences in the next 10-run window

Secondary:

- increase visual pass rate for risky scenes
- reduce semantic mismatch cases where subject class is wrong

### Acceptance criteria

- next 10-run window shows `prompt_conflicting_intent < 3`
- no regression in currently fixed classes:
  - `boots`
  - `hands`
  - `explosions`
  - `wolf`
  - `emotional couple close-up`
- targeted rerun pack for risky scenes passes visual review

### Out of scope

- changing providers
- changing backend orchestration
- retraining models

## B2. Harden `quality_gate_missed_bad_output`

**Status:** Ready  
**Priority:** High  
**Trigger:** Already above intervention threshold (`5` hits in current sample)

### Problem

The quality gate still lets semantically wrong outputs keep a healthy score, or penalizes the wrong thing.

Observed patterns:

- wrong subject class but still scored `0.82`
- visually valid output penalized for the wrong reason
- semantic mismatch not reflected in `qualityReasons`

### Goal

Make quality scoring better at catching bad outputs and avoiding false positives.

### Hypothesis

If the gate includes lightweight semantic checks tied to scene archetype, then:

- obviously wrong outputs will no longer pass as `quality_good`
- false positives will decrease
- degraded tracking will reflect real quality issues instead of noise

### Proposed work

1. Add archetype-aware semantic penalties:
   - `animal_subject`: penalize if prompt implies animal but visual plan still contains dominant human portrait language
   - `effect_scene`: penalize if final prompt includes human portrait dominance
   - `human_detail`: penalize if detail subject is not primary in frame instructions
2. Add scene-class validation hints:
   - `boots`: subject area must be lower-body/detail dominant
   - `hands`: hands must be primary subject, crowd secondary
   - `couple close-up`: tight framing + both faces + visible emotional cues
3. Split false-positive-safe classes from strict semantic classes.
4. Emit explicit `qualityReasons` when a semantic mismatch is detected.
5. Add regression fixtures for:
   - false positive hands case
   - wrong-subject boots case
   - wrong-subject wolf case
   - weak emotional couple framing case

### Metrics

Primary:

- reduce `quality_gate_missed_bad_output` from current baseline to `< 3` occurrences in the next 10-run window

Secondary:

- increase agreement between visual review and quality score
- reduce cases where failed scenes stay at `0.82`

### Acceptance criteria

- next 10-run window shows `quality_gate_missed_bad_output < 3`
- no reintroduction of false-positive penalty on valid hands scenes
- scenes that fail visual review no longer default to `quality_good`

### Out of scope

- replacing the provider
- adding a second full image model judge
- changing render/exposure pipeline
