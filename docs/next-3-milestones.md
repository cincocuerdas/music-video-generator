# Next 3 Milestones

This document defines the next three execution milestones after the backend and generation baseline freeze.

The purpose is to keep work tied to product evidence instead of random technical drift.

## Execution Order

1. Product Validation
2. Cloud Readiness
3. Future Video Provider

Do not start milestone 2 before milestone 1 has usable evidence.
Do not start milestone 3 implementation before milestone 2 is structurally ready.

## Current Focus

Current active focus is **Milestone 1: Product Validation**.

That means:
- keep backend frozen unless a real bug or metric forces a change
- keep generation rules frozen unless repeated evidence justifies a fix
- spend effort on real runs, tracking, and product decisions

---

## Milestone 1: Product Validation

### Goal

Validate that the current pipeline is usable in real conditions, not only in audit runs and synthetic stress cases.

### Why This Comes First

- generation rules were already tuned and frozen
- backend is already stable
- the only rational source of further changes is new product evidence

### Required Work

- run real projects with real songs
- fill `docs/quality-tracking-template.csv`
- fill `docs/scene-quality-tracking-template.csv`
- classify runs as:
  - `usable_as_is`
  - `usable_minor_edits`
  - `not_publishable`
- capture:
  - good scenes
  - bad scenes
  - provider/model used
  - failure tags

### Recommended Minimum Batch

- 10 real runs
- multiple styles
- at least:
  - close-up emotional
  - crowd-heavy
  - narrative
  - text/signage-sensitive

### Outputs Required Before Exit

- completed tracking CSVs
- a summarized quality report from `scripts/dev-tools/summarize_quality_tracking.py`
- a short written decision on whether another generation iteration is justified

### Exit Criteria

- you know the percentage of runs that are `usable_as_is`
- you know the top recurring failure tags
- you know whether `degraded_rate` and `fallback_rate` are acceptable
- you have enough evidence to justify or reject another generation-rule iteration

### Do Not Do

- do not tune prompts because of one bad run
- do not reopen backend architecture during this phase
- do not add new providers during this phase

---

## Milestone 2: Cloud Readiness

### Goal

Prepare the application for a realistic future deployment target:

- frontend on `Vercel`
- backend/jobs on `VM + Docker Compose`

without changing product behavior yet.

### Why This Comes Second

Cloud work without validated product quality is premature.
Once the product is good enough, deployment readiness becomes the next highest leverage move.

### Required Work

- finalize deployment documentation
- finalize environment layout:
  - local
  - cloud-hybrid
  - future video provider
- define storage strategy for:
  - videos
  - images
  - temporary artifacts
- define backup and restore checklist
- define operational checklist for:
  - domain
  - HTTPS
  - secrets
  - logs
  - monitoring

### Outputs Required Before Exit

- deploy checklist for `Vercel + VM/Docker Compose`
- explicit env strategy by tier
- media/storage plan
- backup/restore notes

### Exit Criteria

- the team can describe the target production topology clearly
- `.env` strategy is unambiguous
- storage and media handling are defined
- deployment steps are documented and repeatable

### Do Not Do

- do not move to Kubernetes just because it looks more production-ready
- do not introduce GPU cloud workers yet
- do not rework the core pipeline for infrastructure reasons alone

---

## Milestone 3: Future Video Provider

### Goal

Prepare and prioritize the next major capability:

- `ltx_cloud` as the first future video provider

### Why This Comes Third

This is the most expensive and operationally sensitive feature.
It should only be activated after:

- product quality is validated
- cloud deployment model is clear

### Required Work

- finalize `VideoProvider` contract
- define provider routing rules
- define cost guardrails:
  - per clip
  - per project
  - per user
- define fallback behavior when the provider is unavailable
- define rollout rules:
  - disabled by default
  - feature-flagged
  - only enabled for selected runs/users/projects

### Candidate First Provider

- `ltx_cloud`

Reason:
- pricing is clearer
- integration surface is more concrete
- it fits the architecture already documented in `docs/video-provider-architecture.md`

### Outputs Required Before Exit

- provider interface spec
- env var list
- cost and quota guardrails
- fallback matrix
- rollout checklist

### Exit Criteria

- provider interface is stable enough to implement
- cost ceilings are explicit
- fallback behavior is defined
- implementation can start without architectural improvisation

### Do Not Do

- do not attempt local LTX on current hardware
- do not ship cloud video generation without cost controls
- do not tie the main backend process directly to heavy GPU execution

---

## Decision Rule Between Milestones

Move to the next milestone only if the current one has concrete evidence, not just intent.

Examples:
- do not leave milestone 1 without completed tracking and real product outcomes
- do not leave milestone 2 without a deploy-ready checklist
- do not leave milestone 3 planning without cost and fallback constraints

---

## Immediate Next Actions

### If You Are In Milestone 1

1. finish the current batch of real runs
2. refresh the quality summary script output
3. review top recurring failure tags
4. decide whether another generation fix is justified

### If Milestone 1 Passes

1. move to `docs/cloud-deployment-prep.md`
2. close remaining environment and storage questions
3. define the exact production topology

### If Milestone 2 Passes

1. use `docs/video-provider-architecture.md`
2. scope `ltx_cloud` phase 1 as a feature-flagged provider
3. keep it disabled by default until cost guardrails exist
