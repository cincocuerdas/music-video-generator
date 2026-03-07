# Quality Tracking Guide

Use these two files together:

- `docs/quality-tracking-template.csv`
- `docs/scene-quality-tracking-template.csv`

## Goal

Track 10 real runs with enough structure to answer:

1. Which scene types fail repeatedly
2. Which provider/model combinations drift most
3. Whether quality changes are improving user outcomes

## File 1: Run-Level Tracking

`docs/quality-tracking-template.csv` is one row per finished video.

Required fields:

- `run_id`: stable identifier like `run_001`
- `project_id`: backend project id
- `song_title`
- `style`
- `source_mode`: `lyrics`, `audio`, or `youtube`
  - for manual validation batches, use `audit`
- `total_scenes`
- `real_scenes`
- `fallback_scenes`
- `degraded_scenes`
  - for audit runs, this can mean `scenes that failed visual review`
- `overall_status`: `success`, `degraded`, or `failed`
- `total_likes`
- `total_dislikes`
- `degraded_rate`: `degraded_scenes / total_scenes`
- `fallback_rate`: `fallback_scenes / total_scenes`
- `primary_provider`
- `secondary_provider`
- `top_failure_1..3`: use tags from `docs/generation-failure-taxonomy.md`

## File 2: Scene-Level Tracking

`docs/scene-quality-tracking-template.csv` is one row per scene you review.

Recommended fields:

- `scene_index`
- `timestamp_range`
- `verse_type`
- `verse_text`
- `provider`
- `model`
- `quality_score`
- `exposed`
- `user_feedback`: `like`, `dislike`, or blank
- `failure_tags`: comma-separated tags from `docs/generation-failure-taxonomy.md`
- `passed_visual_review`: `yes` or `no`
- `reason`: short explanation of failure or approval

## Minimal Workflow

For each run:

1. Fill one row in `quality-tracking-template.csv`
2. Review only the bad or risky scenes, plus 1-2 good scenes
3. Fill those scenes in `scene-quality-tracking-template.csv`
4. Reuse tags from `docs/generation-failure-taxonomy.md`
5. Set the `decision` field (see below)

## Decision Field

Each run gets a `decision` value in `quality-tracking-template.csv`:

| Value | Meaning |
|-------|---------|
| `usable_as_is` | Can publish without human editing |
| `usable_minor_edits` | Needs crop/color/minor retouch on <=2 scenes |
| `not_publishable` | Fundamental failures; cannot ship |
| `pending_review` | Not yet reviewed (default for new runs) |

Decision drives the summary dashboard in `summarize_quality_tracking.py`.

## Recommended Failure Tags

Use a small consistent set first:

- `prompt_under_specified`
- `prompt_conflicting_intent`
- `routing_wrong_provider`
- `multi_person_anatomy`
- `background_face_distortion`
- `text_render_failure`
- `action_pose_failure`
- `mouth_teeth_artifact`
- `hand_finger_artifact`
- `identity_drift`
- `quality_gate_missed_bad_output`
- `fallback_overuse`

## Optional SmolVLM Auxiliary Signal

If you use `SmolVLM2-500M-Video-Instruct`, treat it as a low-confidence helper only.

Allowed uses:

- `Is there a crowd?`
- `Is the main subject human?`
- `Is there an animal as the main subject?`
- `Is there readable text/signage?`
- `Is this mostly a close-up?`

Do not use it for:

- anatomy quality (`hands`, `mouth`, `eyes`)
- identity consistency
- pass/fail decisions
- automatic score penalties
- judging a full multiscene final video against a single-scene prompt

Tracking policy:

- record SmolVLM outputs as `auxiliary_signal`
- keep human review as the source of truth
- never change generation rules from SmolVLM alone

Suggested extra scene fields if you use it:

- `smolvlm_used`
- `smolvlm_question`
- `smolvlm_answer`
- `smolvlm_confidence`
- `smolvlm_confirmed_by_human`

## Decision Rule For Next Iteration

Only change generation rules when a failure pattern appears:

- at least `3` times across the 10 runs, or
- at least `2` times in the same scene class with the same provider/model

That avoids overfitting the pipeline to isolated bad generations.
