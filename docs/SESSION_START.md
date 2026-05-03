# Session Start Checklist

Every Codex instance must do this before changing code:

1. Read `docs/REWRITE_STATUS.md`.
2. Read the current phase in `docs/REWRITE_PLAN.md`.
3. Read `docs/CDP_ONLY_CONTRACT.md`.
4. Read `docs/LIVE_TEST_MATRIX.md`.
5. Read `docs/LEGACY_ARCHIVE_POLICY.md`.
6. If working on Phase 10, read `docs/PHASE10_LIVE_VALIDATION.md`.
7. Run `git status --short`.
8. Run `npm run scan:runtime` and `npm run gate:phase9-static`.
9. Treat `raw_active_findings` as the legacy debt inventory and `reachable_findings` as the strict active gate.
10. Continue only from the `Next exact task` recorded in `docs/REWRITE_STATUS.md`.

Every implementation session must end by updating `docs/REWRITE_STATUS.md` with:

- workstream status
- files changed
- tests run
- live test result, if any
- blockers
- next exact task
