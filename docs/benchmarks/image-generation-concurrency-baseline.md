# Image Generation Concurrency Benchmark

- Timestamp (UTC): 2026-02-23T02:50:29.656Z
- Provider: `mock`
- Scene count per run: `12`
- Runs per concurrency: `5`
- Warmup runs per concurrency: `1`
- Python command: `python`

| Concurrency | Runs | Mean (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Speedup vs 1x (p50) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 306.5 | 309.0 | 351.3 | 249.5 | 354.4 | 1.00x |
| 2 | 5 | 288.0 | 289.9 | 304.1 | 263.4 | 307.4 | 1.07x |
| 4 | 5 | 274.7 | 271.8 | 285.8 | 269.0 | 289.3 | 1.14x |
| 6 | 5 | 252.1 | 256.2 | 263.8 | 230.4 | 264.1 | 1.21x |

**Recommendation:** use `IMAGE_GENERATION_CONCURRENCY=6` (best p95=263.8ms).

## Notes

- This benchmark isolates image-stage generation (`generate_images.py`) and is deterministic only for the configured provider.
- Re-run after infrastructure/model/provider changes and compare p50/p95 drift.

