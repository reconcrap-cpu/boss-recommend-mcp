# Legacy Research Quarantine

This folder contains preserved legacy Boss automation code for future research only.

Policy: `docs/LEGACY_ARCHIVE_POLICY.md`.

Rules:

- Code under `legacy/research/` is not part of active runtime behavior.
- Clean npm installs must not include this folder.
- New recommend, recruit/search, and chat work must use the CDP-only `src/core`, `src/domains`, and MCP entrypoint modules.
- Do not import from this folder in active package code.
- Any legacy behavior needed in production must be rewritten into CDP-only modules and live-verified before use.
