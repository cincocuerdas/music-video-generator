# Pipeline Flow

Main stages:

1. `YOUTUBE_DOWNLOAD`
2. `TRANSCRIPTION`
3. `ANALYZE_LYRICS`
4. `GENERATE_IMAGES`
5. `RENDER_VIDEO`
6. `FINALIZE`

## Notes

- `ANALYZE_LYRICS` produces timed scenes with `startTime`, `endTime`, `duration`, `visualPrompt`.
- `GENERATE_IMAGES` stores scene image metadata in `analysisResult.generatedImages`.
- Quality gating may mark frames as `exposed=false`.
- `RENDER_VIDEO` must preserve timeline duration and keep scene selection synchronized with rendered output.
- The thumbnail intro is used before first real verse based on scene timing.

## Common Quality Issues Tracked in This Project

- Scene/video desync in UI timestamps.
- Anatomical artifacts (extra fingers, fused hands/arms, deformed faces/eyes/mouths).
- Overcrowded multi-person prompts hurting realism.
