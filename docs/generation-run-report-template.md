# Generation Run Report Template

Use this after each real pipeline run. Keep it short and comparable across runs.

## Run Header

| Field | Value |
|-------|-------|
| Project ID | |
| Song | |
| Source mode | |
| Run date | |
| Backend commit | |
| Generator commit | |
| Video path | |

## Outcome

| Metric | Value |
|--------|-------|
| Pipeline status | |
| Degraded | |
| Degraded reasons | |
| Total scenes | |
| Real scenes | |
| Fallback scenes | |
| Duration | |

## Provider Distribution

| Provider | Scene count | Notes |
|----------|-------------|-------|
| Gemini | | |
| ComfyUI | | |
| Pollinations | | |
| Replicate | | |
| Mock / fallback | | |

## Quality Summary

| Category | Count | Notes |
|----------|-------|-------|
| Good scenes | | |
| Acceptable scenes | | |
| Bad scenes | | |
| Mouth defects | | |
| Hand defects | | |
| Crowd/background defects | | |
| Text defects | | |
| Action defects | | |
| Identity drift scenes | | |

## Worst Scenes

| Scene | Timestamp | Primary tag | Root cause guess | Action |
|-------|-----------|-------------|------------------|--------|
| | | | | |
| | | | | |
| | | | | |

## Best Scenes

| Scene | Timestamp | Why it worked |
|-------|-----------|---------------|
| | | |
| | | |
| | | |

## Recommended Changes

### Prompt

1. 
2. 

### Routing

1. 
2. 

### Quality Gate

1. 
2. 

### Provider Strategy

1. 
2. 

## Decision

Choose one:

- keep current settings
- tweak prompts only
- tweak routing only
- tweak quality gate only
- rerun with mixed changes
- reject run as non-usable
