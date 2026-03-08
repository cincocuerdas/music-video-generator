# Product Validation Runbook

This runbook operationalizes **Milestone 1: Product Validation**.

Use it when validating whether the current pipeline is good enough for real use, not just audit experiments.

## Scope

This phase is about:
- running real songs/projects
- reviewing scene quality with discipline
- deciding whether the current generator is publishable enough

This phase is **not** about:
- reopening backend architecture
- adding new providers
- tuning prompts because of one bad run
- making cloud decisions without product evidence

## Source of Truth

There are two tracking layers. Keep them synchronized.

1. `output/audit/AUDIT_RUNS.md`
   - human-readable ledger
   - run-by-run notes
   - best/worst scenes
   - product decision per run

2. `docs/quality-tracking-template.csv`
   - one row per run
   - machine-readable summary

3. `docs/scene-quality-tracking-template.csv`
   - one row per reviewed scene
   - machine-readable scene evidence

Rule:
- `AUDIT_RUNS.md` is the narrative source of truth.
- The CSV files are the summary source of truth for scripts and dashboards.
- After every batch review, update both.

## Current Reality

The current CSV summary is behind the Markdown ledger.

As of now:
- `output/audit/AUDIT_RUNS.md` tracks 11 runs / 55 scenes
- `scripts/dev-tools/summarize_quality_tracking.py` still reports 6 runs / 31 scenes because the CSVs are not fully synchronized

Before using summary output for decisions, sync the CSVs with the reviewed runs.

## Batch Definition

A product-validation batch should contain:
- 10 real or realistic runs minimum
- multiple style clusters
- multiple risky scene types

Recommended style coverage:
- cinematic
- film noir
- crowd-heavy
- close-up emotional
- at least one style with text/signage sensitivity

Recommended scene coverage across the batch:
- close-up emotional faces
- multi-person scenes
- crowds/background faces
- hands visible
- text/signage
- animals or non-human subjects
- action / motion implication

## Per-Run Workflow

For each run:

1. Generate the project and keep all artifacts.
2. Save or reference:
   - final video path
   - project id
   - provider/model used
   - key good scenes
   - key bad scenes
3. Fill one row in `docs/quality-tracking-template.csv`.
4. Review only:
   - risky scenes
   - bad scenes
   - 1-2 clearly good scenes
5. Fill reviewed scenes in `docs/scene-quality-tracking-template.csv`.
6. Update `output/audit/AUDIT_RUNS.md` with:
   - best scenes
   - worst scenes
   - decision
   - evidence tags

## Required Fields Per Run

At minimum, capture:
- `run_id`
- `project_id`
- `song_title`
- `style`
- `source_mode`
- `total_scenes`
- `real_scenes`
- `fallback_scenes`
- `degraded_scenes`
- `overall_status`
- `primary_provider`
- `decision`

Decision must be exactly one of:
- `usable_as_is`
- `usable_minor_edits`
- `not_publishable`
- `pending_review`

Do not use free-text in the CSV `decision` column.

## Required Fields Per Reviewed Scene

At minimum, capture:
- `run_id`
- `scene_index`
- `timestamp_range`
- `verse_type`
- `provider`
- `model`
- `quality_score`
- `passed_visual_review`
- `failure_tags`
- `reason`

Use failure tags only from:
- `docs/generation-failure-taxonomy.md`

## Review Discipline

Human review is the source of truth.

When reviewing a scene, judge:
- does it match the prompt intent?
- does it match the lyric intent?
- is the subject correct?
- are anatomy and facial details acceptable?
- is background integrity acceptable?
- is text usable when text matters?

Optional SmolVLM signals may help prioritize review, but never decide pass/fail.

## Decision Rule For Generator Changes

Only change generation rules when a pattern appears:
- at least 3 times across the batch, or
- at least 2 times in the same scene class with the same provider/model

This avoids overfitting to isolated bad generations.

## Commands

Recompute current machine summary:

```powershell
cd C:\PROJECT
python scripts/dev-tools/summarize_quality_tracking.py
```

Useful quality artifacts already available:
- `docs/generation-run-report-template.md`
- `docs/generation-quality-audit-template.md`
- `docs/quality-improvement-backlog.md`

## Batch Exit Criteria

Milestone 1 is complete only when all of the following are true:

1. At least 10 runs are tracked.
2. CSVs are synchronized with the reviewed runs.
3. Every run has a valid `decision`.
4. Top recurring failure tags are known.
5. `degraded_rate` and `fallback_rate` are understood and judged acceptable or unacceptable.
6. There is a written product conclusion:
   - good enough to move forward
   - needs one more generation iteration
   - not ready for broader usage

## Immediate Next Actions

1. Sync the CSV rows with the runs already documented in `output/audit/AUDIT_RUNS.md`.
2. Re-run `python scripts/dev-tools/summarize_quality_tracking.py`.
3. Review the summary output for:
   - `decision_breakdown`
   - `top_failure_tags`
   - intervention candidates
4. Write one short conclusion for the batch:
   - current usable rate
   - top defects
   - whether another generation change is justified

## Stop Conditions

Do not continue tuning if:
- the current batch is not fully reviewed
- the CSVs and Markdown ledger disagree
- a proposed fix is based on one isolated scene

The point of this milestone is evidence, not motion.
