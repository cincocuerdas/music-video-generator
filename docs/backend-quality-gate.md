# Backend Quality Gate

This repository now includes `.github/workflows/backend-quality.yml` with:

- PR/Push gate: build + critical backend tests
- Nightly E2E: browser regression (`test:e2e-pipeline`)
- Artifact upload for logs on failures

## Required Status Check (GitHub UI)

Set this check as required on your protected branch (usually `main`):

- Workflow/job: `Backend Quality Gate / Build + Critical Backend Tests`

Path in GitHub UI:

1. `Settings`
2. `Branches`
3. `Branch protection rules`
4. Edit rule for `main`
5. Enable `Require status checks to pass before merging`
6. Select `Backend Quality Gate / Build + Critical Backend Tests`

## Optional: Apply via GitHub REST API

If you prefer API automation, replace placeholders and execute:

```bash
curl -L -X PUT \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <GITHUB_TOKEN_WITH_REPO_ADMIN>" \
  https://api.github.com/repos/<OWNER>/<REPO>/branches/main/protection \
  -d '{
    "required_status_checks": {
      "strict": true,
      "contexts": [
        "Backend Quality Gate / Build + Critical Backend Tests"
      ]
    },
    "enforce_admins": true,
    "required_pull_request_reviews": null,
    "restrictions": null
  }'
```

## Notes

- Nightly E2E job is heavy by design and is not part of PR gate.
- Logs are uploaded from:
  - `storage/tmp-tests/*`
  - `storage/logs/*`
