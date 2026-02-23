# Image Generation Concurrency Benchmark

- Timestamp (UTC): 2026-02-23T02:33:15.257Z
- Provider: `mock`
- Scene count per run: `12`
- Runs per concurrency: `5`
- Warmup runs per concurrency: `1`
- Python command: `python`

| Concurrency | Runs | Mean (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Speedup vs 1x (p50) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 275.0 | 282.9 | 283.3 | 254.5 | 283.4 | 1.00x |
| 2 | 5 | 275.2 | 273.0 | 302.8 | 247.7 | 308.3 | 1.04x |
| 4 | 5 | 271.5 | 275.2 | 279.3 | 261.8 | 279.8 | 1.03x |
| 6 | 5 | 264.9 | 267.7 | 282.0 | 238.7 | 282.8 | 1.06x |

**Recommendation:** use `IMAGE_GENERATION_CONCURRENCY=4` (best p95=279.3ms).

## Notes

- This benchmark isolates image-stage generation (`generate_images.py`) and is deterministic only for the configured provider.
- Re-run after infrastructure/model/provider changes and compare p50/p95 drift.

