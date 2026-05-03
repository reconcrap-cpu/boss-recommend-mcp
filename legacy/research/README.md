# Research-Only Legacy Code

This directory is an archive, not an implementation layer.

The files here are retained to study old behavior while the active Boss MCP runtime is rewritten around CDP-only browser access. They may contain page-JS and `Runtime.evaluate` usage by design; that is why they are quarantined.

Rules:

- Do not import from this directory in active package code.
- Do not add npm scripts that execute files from this directory.
- Do not include this directory in `package.json#files`.
- Do not use mock-only results from this directory as a completion signal.
- Rewrite any needed behavior into `src/core` or `src/domains`, then live-test it against Boss Chrome before marking it complete.
