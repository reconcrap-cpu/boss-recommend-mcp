# Legacy Archive Policy

Decision: keep `legacy/research/` in this repository as an in-repo research archive.

This is a storage policy only. It does not make legacy code an active runtime path.

## Rules

- `legacy/research/` is preserved for reference, comparison, and future migration research.
- Clean npm installs must not include `legacy/`, package-local `vendor/`, rewrite docs, live scripts, scanner scripts, or development tests.
- Active code must not import, execute, dynamically load, spawn, or path-resolve package-local legacy files.
- Active recommend, recruit/search, and chat behavior must live under `src/core`, `src/domains`, and the CDP-only MCP/CLI entrypoints.
- Any behavior copied from legacy code must be rewritten to the CDP-only contract, pass live Boss validation, and be documented before it can be treated as complete.
- Mock or unit tests may support development, but they cannot mark a module complete without live evidence.

## Enforced Gates

- `npm run scan:runtime:strict`: no reachable active Runtime/page-JS findings.
- `npm run scan:runtime:package:strict`: no forbidden Runtime/page-JS findings in the npm publish surface.
- `npm run scan:legacy-boundary`: no active references back into `legacy/research/`, package-local Boss vendor paths, moved legacy modules, moved legacy tests, or moved legacy rules.
- `npm run scan:package-boundary`: `npm pack --dry-run --json` must not include archived legacy code, package-local vendors, live scripts, scanner scripts, docs, or development tests.
- Installed-package smoke tests must verify the package has no `legacy/` or `vendor/` directory and still works against the live Boss Chrome target without `Runtime.*`.

## Handoff

New Codex sessions must read this file together with `docs/REWRITE_STATUS.md`, `docs/REWRITE_PLAN.md`, `docs/CDP_ONLY_CONTRACT.md`, and `docs/LIVE_TEST_MATRIX.md` before editing. If a future session changes this policy, it must update all affected docs, scanners, and live test matrix rows in the same session.
