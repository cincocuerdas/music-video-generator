# Backend Fire Drill Report

- Generated at (UTC): 2026-02-23T02:51:13.493Z

| Scenario | Status | Duration (ms) | Recovery (ms) | Notes |
|---|---|---:|---:|---|
| redis_recovery | PASS | 28653 | 28647 | validated through test:resilience |
| postgres_restart_recovery | PASS | 12657 | 742 | postgres restart + pgvector ready + pipeline-status pass |
| external_dependency_degraded_mode | PASS | 9850 | 9845 | validated degraded fallback under dependency outage |

