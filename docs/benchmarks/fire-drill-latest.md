# Backend Fire Drill Report

- Generated at (UTC): 2026-02-23T02:34:41.096Z

| Scenario | Status | Duration (ms) | Recovery (ms) | Notes |
|---|---|---:|---:|---|
| redis_recovery | PASS | 28753 | 28747 | validated through test:resilience |
| postgres_restart_recovery | PASS | 13764 | 2075 | postgres restart + pgvector ready + pipeline-status pass |
| external_dependency_degraded_mode | PASS | 9544 | 9539 | validated degraded fallback under dependency outage |

