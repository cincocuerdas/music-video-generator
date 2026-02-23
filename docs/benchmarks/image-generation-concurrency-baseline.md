# Image Generation Concurrency Benchmark

- Timestamp (UTC): 2026-02-23T01:06:50.873Z
- Provider: `mock`
- Scene count per run: `12`
- Runs per concurrency: `5`
- Warmup runs per concurrency: `1`
- Python command: `python`

| Concurrency | Runs | Mean (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Speedup vs 1x (p50) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 241.1 | 242.6 | 253.0 | 228.5 | 253.0 | 1.00x |
| 2 | 5 | 250.3 | 247.0 | 267.7 | 227.8 | 269.3 | 0.98x |
| 4 | 5 | 244.0 | 241.4 | 256.0 | 232.9 | 257.3 | 1.01x |
| 6 | 5 | 231.8 | 228.7 | 242.2 | 226.1 | 244.7 | 1.06x |

**Recommendation:** use `IMAGE_GENERATION_CONCURRENCY=6` (best p95=242.2ms).

## Notes

- This benchmark isolates image-stage generation (`generate_images.py`) and is deterministic only for the configured provider.
- Re-run after infrastructure/model/provider changes and compare p50/p95 drift.

