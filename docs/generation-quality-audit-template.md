# Generation Quality Audit Template

Use this template to review one real pipeline run end to end. The goal is to classify visible failures consistently and convert them into routing, prompt, or provider changes.

## 1. Run Metadata

| Field | Value |
|-------|-------|
| Project ID | |
| Song / Source | |
| Source mode | `youtube` / `audio` / `lyrics` |
| Run date | |
| Visual style | |
| Total scenes | |
| Real scenes | |
| Fallback scenes | |
| Pipeline status | `success` / `degraded` / `failed` |
| Degraded reasons | |
| Video path | |

## 2. Global Assessment

| Dimension | Score (1-5) | Notes |
|-----------|-------------|-------|
| Lyrics to scene coherence | | |
| Character consistency | | |
| Anatomy quality | | |
| Faces / mouths / eyes | | |
| Hands | | |
| Multi-person scenes | | |
| Text / signage | | |
| Motion / action plausibility | | |
| Background integrity | | |
| Overall usefulness | | |

## 3. Scene Review

Repeat one block per scene.

### Scene N

| Field | Value |
|-------|-------|
| Timestamp | |
| Scene index | |
| Provider | |
| Model | |
| Verse type | |
| Detected traits | |
| Prompt | |
| Output image path | |
| Quality score | |
| Is fallback | `true` / `false` |
| Is degraded | `true` / `false` |

#### Scene verdict

| Check | Pass / Fail | Notes |
|-------|-------------|-------|
| Matches lyric meaning | | |
| Matches intended emotion | | |
| Main subject readable | | |
| Face quality acceptable | | |
| Mouth quality acceptable | | |
| Hand quality acceptable | | |
| Background people acceptable | | |
| Text rendering acceptable | | |
| Action pose believable | | |
| No major artifact | | |

#### Failure tags

Use tags from `docs/generation-failure-taxonomy.md`.

```text
tag1, tag2, tag3
```

#### Root cause guess

Pick one primary cause:

- prompt under-specified
- prompt over-complex
- routing wrong provider
- provider limitation
- quality gate too weak
- exposure / frame selection
- fallback cascade
- unknown

#### Suggested correction

Write one concrete change only.

## 4. Run Summary

| Metric | Value |
|--------|-------|
| Scenes reviewed | |
| Scenes accepted as good | |
| Scenes needing regen | |
| Scenes with anatomy defects | |
| Scenes with crowd/background defects | |
| Scenes with text defects | |
| Scenes with action defects | |
| Scenes with identity drift | |
| Scenes with fallback | |

## 5. Top 3 Problems

1. |
2. |
3. |

## 6. Next Actions

1. Prompt changes:
2. Routing changes:
3. Provider changes:
4. Quality gate changes:
5. No action / acceptable tradeoff:
