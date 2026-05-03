# Legacy Runtime Inventory

This inventory is generated and refreshed with `npm run scan:runtime`.

Last scan: 2026-05-02 11:12 Asia/Shanghai.

Scan summary:

- Total findings: 459
- Raw non-allowed findings: 457
- Reachable active findings: 0
- Legacy quarantined findings: 457
- Allowed guard findings: 2
- Strict gate: pass
- By domain: recommend 287, chat 89, recruit 83

Package-surface scan summary:

- Command: `npm run scan:runtime:package:strict`
- Total findings: 2
- Raw non-allowed findings: 0
- Reachable active findings: 0
- Legacy quarantined findings: 0
- Allowed guard findings: 2
- Strict gate: pass
- `npm pack --dry-run --json` entry count: 49
- Quarantined or blocked paths included in package: 0

Legacy boundary scan summary:

- Command: `npm run scan:legacy-boundary`
- Active files scanned: 82
- Findings: 0
- Strict gate: pass
- Scope: active `bin/`, `src/`, package scripts/files, and live scripts
- Boundary: active code must not reference `legacy/research/`, package-local Boss vendor paths, moved legacy modules, moved legacy tests, or moved legacy healing rules

Package boundary scan summary:

- Command: `npm run scan:package-boundary`
- Source: real `npm pack --dry-run --json` output
- Entry count: 49
- Findings: 0
- Strict gate: pass
- Boundary: clean npm packages must not include `legacy/`, package-local `vendor/`, `docs/`, live scripts, scanner scripts, development tests, moved legacy modules, or moved legacy rules

Aggregate Phase 9 static gate:

- Command: `npm run gate:phase9-static`
- Gates: `scan:runtime:strict`, `scan:runtime:package:strict`, `scan:legacy-boundary`, `scan:package-boundary`
- Status: pass

## Current hotspots

| Area | Path | Status | Migration target |
| --- | --- | --- | --- |
| Research-only quarantine | `legacy/research/` | legacy-quarantined | Package-local legacy modules, legacy tests, and vendor automation were moved here intact for future research only. Active code must not import from this folder, and clean npm installs exclude it |
| Archive policy | `docs/LEGACY_ARCHIVE_POLICY.md` | rewritten | Final policy is to keep `legacy/research/` in this repo as an inert research archive, protected by runtime, legacy-boundary, package-boundary, and installed-package live gates |
| Recommend adapters | `legacy/research/src/adapters.js` | legacy-quarantined | MCP lifecycle execution now routes through `src/recommend-mcp.js` and `src/domains/recommend`; active package entrypoints no longer import this module |
| Recommend self-heal | `legacy/research/src/self-heal.js` | legacy-quarantined | `run_recommend_self_heal` scan now routes through shared CDP-only `src/core/self-heal`; apply mode is fenced with `RECOMMEND_SELF_HEAL_APPLY_UNSUPPORTED_CDP_ONLY` |
| Recommend selector expression helpers | `legacy/research/src/recommend-healing-config.js` | legacy-quarantined | Retained for research only; replacement target is selector/probe configs in shared self-heal |
| Recommend search vendor | `legacy/research/vendor/boss-recommend-search-cli` | legacy-quarantined | Retained for research only; CDP-only recruit/search execution uses `src/domains/recruit` |
| Recommend screen vendor | `legacy/research/vendor/boss-recommend-screen-cli` | legacy-quarantined | Retained for research only; CDP-only recommend execution uses `src/domains/recommend` |
| Chat vendor/runtime | `legacy/research/vendor/boss-chat-cli`, `legacy/research/src/boss-chat.js` | legacy-quarantined | CDP-only `src/domains/chat`, `src/chat-mcp.js`, and `src/chat-runtime-config.js` replace this runtime. Active package entrypoints and npm scripts no longer import or call it |
| Recommend follow-up chat chain | Active recommend MCP `follow_up.chat` input | legacy-only fenced | Product decision on 2026-05-03: the old recommend -> chat chained orchestration is not part of the CDP-only rewrite. Active recommend MCP fails closed for `follow_up.chat`; direct chat MCP remains the supported CDP-only route, and old chained behavior belongs only in legacy/research reference code |
| Recruit source | `C:\Users\yaolin\Documents\codex_projects\boss recruit pipeline\boss-recruit-mcp` | legacy-quarantined external-source | Instruction parsing, first search/detail/screening/lifecycle slice, MCP lifecycle wrappers, terminal status parity, old-style run aliases, sync `result.run_id`/processed-count compatibility, persisted run snapshots, checkpoint JSON, result CSV, report JSON, and disk-only status fallback imported into `src/domains/recruit` plus `src/recruit-mcp.js`; city edge handling for `全国` and invalid-city defaulting is CDP-only/live-verified; external vendor automation is retained as migration-reference code outside package entrypoint execution |
| Package publish surface | `package.json#files` | rewritten | Publish surface now includes only `bin`, `config/screening-config.example.json`, `skills`, `scripts/postinstall.cjs`, `src/core`, `src/domains`, CDP-only MCP/CLI/shared entrypoints, and README. It excludes `legacy/`, `vendor/`, `docs/`, live scripts, scanner/dev tests, and quarantined legacy modules |
| Legacy boundary guard | `scripts/scan-legacy-boundary.js` | rewritten | Active code/package scripts/live scripts now have a hard guard against references back into package-local legacy quarantine, moved legacy modules/tests/rules, and package-local Boss vendor paths |
| Package boundary guard | `scripts/scan-package-boundary.js` | rewritten | Real npm dry-run package contents now have a hard guard against archived legacy, package-local vendors, docs, live/scanner scripts, development tests, and moved legacy modules/rules |
| Aggregate Phase 9 gate | `scripts/phase9-static-gate.js` | rewritten | Runs runtime strict, package runtime strict, legacy boundary, and package boundary as a single pre-Phase-10 static gate |
| CLI doctor package dependency checks | `src/cli.js` | rewritten | `doctor` now validates package-root dependencies (`chrome-remote-interface`, `ws`, `sharp`) and no longer checks package-local legacy recommend search/screen vendor directories or entry files |

## Last scan by file

| Source | Findings |
| --- | ---: |
| `src/core/browser/index.js` | 2 allowed guard references |
| `legacy/research/src/adapters.js` | 31 quarantined |
| `legacy/research/src/recommend-healing-config.js` | 2 quarantined |
| `legacy/research/src/self-heal.js` | 120 quarantined |
| `legacy/research/vendor/boss-chat-cli/src/browser/chat-page.js` | 85 quarantined |
| `legacy/research/vendor/boss-chat-cli/src/services/chrome-client.js` | 1 quarantined |
| `legacy/research/vendor/boss-chat-cli/src/services/resume-capture.js` | 3 quarantined |
| `legacy/research/vendor/boss-recommend-screen-cli/boss-recommend-screen-cli.cjs` | 80 quarantined |
| `legacy/research/vendor/boss-recommend-screen-cli/scripts/capture-full-resume-canvas.cjs` | 5 quarantined |
| `legacy/research/vendor/boss-recommend-search-cli/src/cli.js` | 47 quarantined |
| recruit `src/adapters.js` | 3 quarantined |
| recruit `vendor/boss-screen-cli/boss-screen-cli.cjs` | 43 quarantined |
| recruit `vendor/boss-screen-cli/calibrate-favorite-position-v2.cjs` | 5 quarantined |
| recruit `vendor/boss-search-cli/src/boss-searcher.js` | 29 quarantined |
| recruit `vendor/boss-search-cli/src/chrome-connector.js` | 3 quarantined |

## Phase 9 Notes

- 2026-05-01 20:58 Asia/Shanghai: first quarantine slice live-verified for chat MCP helper split. Added `src/chat-runtime-config.js`, rerouted `src/chat-mcp.js` helper imports, removed the legacy prepare call from `start_boss_chat_run` missing-input responses, and re-passed `npm run live:chat-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --timeout-ms 480000 --save-report .live-artifacts\chat-mcp-phase9-helper-split-live.json`.
- 2026-05-01 21:01 Asia/Shanghai: second quarantine slice live-verified for `src/index.js` legacy import fencing. Removed static imports of `src/adapters.js`, `src/boss-chat.js`, `src/pipeline.js`, and `src/self-heal.js` from the MCP entrypoint; those modules now load only when legacy calibration/self-heal/prepare/detached-worker paths are called. Re-passed `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-phase9-index-lazy-live.json`.
- 2026-05-01 21:08 Asia/Shanghai: third quarantine slice live-verified for `src/cli.js` legacy import fencing. Removed static imports of `src/adapters.js`, `src/boss-chat.js`, and `src/pipeline.js` from the CLI entrypoint; those modules now load only for legacy CLI commands such as `run`, `doctor`, `calibrate`, `launch-chrome`, `where`, `install`, `init-config`, and `chat`. Re-passed `node bin\boss-recommend-mcp.js help`, `node bin\boss-recommend-mcp.js where`, and `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-phase9-cli-lazy-live.json`.
- 2026-05-01 21:17 Asia/Shanghai: fourth quarantine slice live-verified for scanner reachability/quarantine awareness. `scripts/scan-forbidden-runtime.js` now emits `status` per finding (`active`, `legacy-quarantined`, or `allowed`), records quarantine reasons, preserves raw non-allowed counts, and makes `--fail-on-findings` fail only for reachable active findings. Added `src/test-runtime-scan.js` plus `npm run test:runtime-scan`; `npm run scan:runtime:strict` passed with 459 total findings, 457 raw non-allowed findings, 0 reachable active findings, 457 legacy-quarantined findings, and 2 allowed guard references. Re-passed `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-phase9-scanner-aware-live.json`.
- 2026-05-01 21:28 Asia/Shanghai: fifth quarantine slice live-verified for CDP-only `prepare_boss_chat_run`. Added `src/domains/chat/jobs.js`, routed the MCP prepare handler through `src/chat-mcp.js`, and removed the remaining prepare-route dependency on `src/boss-chat.js`. Re-passed `npm run live:chat-mcp -- --prepare-first --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --timeout-ms 480000 --save-report .live-artifacts\chat-mcp-phase9-prepare-cdp-live.json`; prepare returned `NEED_INPUT`, discovered 9 options from `.chat-job .ui-dropmenu-list li`, then the chat run `mcp_chat_momy7hpq_4r039ioi` processed 2 live chat candidates, canceled cleanly, and logged no `Runtime.*`.
- 2026-05-01 21:40 Asia/Shanghai: sixth quarantine slice live-verified for CDP-only `boss_chat_health_check`. Moved MCP health handling to `src/chat-mcp.js`, added shared config/runtime resolution in `src/chat-runtime-config.js`, and removed the health-route dependency on `src/boss-chat.js`. Re-passed `npm run live:chat-mcp -- --health-first --prepare-first --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --timeout-ms 480000 --save-report .live-artifacts\chat-mcp-phase9-health-cdp-live.json`; health returned `OK`, saw 40 chat cards and 1,368 AX nodes, then the chat run `mcp_chat_momyn52n_reb7bjag` processed 2 live chat candidates, canceled cleanly, and logged no `Runtime.*`.
- 2026-05-01 21:52 Asia/Shanghai: seventh quarantine slice live-verified for CDP-only chat CLI routing. `src/cli.js` no longer imports or lazy-loads `src/boss-chat.js`; chat runtime directory setup and `where` use `src/chat-runtime-config.js`, `chat health-check` and `chat prepare-run` call `src/chat-mcp.js`, status/control subcommands call CDP-only run service snapshot APIs, and `chat run/start-run` return `CHAT_CLI_ASYNC_UNSUPPORTED_CDP_ONLY`. Live commands `node src\cli.js chat health-check --slow-live --port 9222` and `node src\cli.js chat prepare-run --slow-live --port 9222` passed against `https://www.zhipin.com/web/chat/index`; health saw 40 chat cards and 1,368 AX nodes, prepare discovered 9 job options, and both method logs had no `Runtime.*`.
- 2026-05-01 22:00 Asia/Shanghai: eighth quarantine slice package-entrypoint verified for pure `boss-recommend-mcp where` path resolution. `printPaths()` no longer lazy-loads `src/adapters.js`; it resolves chat runtime paths through `src/chat-runtime-config.js` and calibration target/script paths through local pure filesystem helpers. `node src\cli.js where` wrote `.live-artifacts\cli-where-phase9-pure-paths.txt`, resolved the recruit calibration script from `C:\Users\yaolin\Documents\codex_projects\boss recruit pipeline\boss-recruit-mcp\vendor\boss-screen-cli\calibrate-favorite-position-v2.cjs`, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- 2026-05-01 22:06 Asia/Shanghai: ninth quarantine slice package-entrypoint verified for pure CLI config target resolution. Exported `getBossScreenConfigResolution()` from `src/chat-runtime-config.js` and changed `src/cli.js` `resolveCliConfigTarget`, `ensureUserConfig`, `config set`, and `set-port` to use it instead of lazy-loading `src/adapters.js`. Isolated temp-config commands for `init-config`, `config set`, and `set-port` passed, preserved `debugPort=9222`, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- 2026-05-01 22:13 Asia/Shanghai: tenth quarantine slice live/package-entrypoint verified for CDP-only `boss-recommend-mcp launch-chrome`. `src/cli.js` now inspects/reuses Boss recommend tabs with local DevTools/CDP helpers, verifies `iframe[name="recommendFrame"]` through CDP DOM, opens/navigates recommend through `/json/new` or guarded `Page.navigate` fallback, and no longer lazy-loads `src/adapters.js` for this command. Live commands `node src\cli.js launch-chrome --port 9222 --slow-live` and `node bin\boss-recommend-mcp.js launch-chrome --port 9222 --slow-live` both reused Chrome `127.0.0.1:9222`, verified `https://www.zhipin.com/web/chat/recommend`, brought the tab forward with `Page.enable` / `Page.bringToFront`, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- 2026-05-01 22:21 Asia/Shanghai: eleventh quarantine slice live/package-entrypoint verified for CDP-only `boss-recommend-mcp doctor`. `src/cli.js` now builds doctor preflight checks with pure filesystem/config/dependency helpers plus the CDP-only recommend page inspector, and no longer lazy-loads `src/adapters.js` for this command. Live commands `node src\cli.js doctor --port 9222 --page-scope recommend --slow-live` and `node bin\boss-recommend-mcp.js doctor --port 9222 --page-scope recommend --slow-live` both returned `ok=true`, verified `https://www.zhipin.com/web/chat/recommend`, detected `iframe[name="recommendFrame"]` through `Page.enable`, `DOM.enable`, `DOM.getDocument`, `DOM.querySelector`, and `DOM.describeNode`, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- 2026-05-01 22:25 Asia/Shanghai: twelfth quarantine slice package-entrypoint verified for fenced CDP-only `boss-recommend-mcp calibrate`. `src/cli.js` no longer lazy-loads `src/adapters.js` or delegates to the external calibration script for this command; it returns structured `CALIBRATE_UNSUPPORTED_CDP_ONLY` with `cdp_only=true`, `runtime_evaluate_used=false`, and empty `method_log`. Commands `node src\cli.js calibrate --port 9222 --timeout-ms 5000` and `node bin\boss-recommend-mcp.js calibrate --port 9222 --timeout-ms 5000` both exited `1` intentionally, performed no browser interaction, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- 2026-05-01 22:31 Asia/Shanghai: thirteenth quarantine slice package-entrypoint verified for fenced CDP-only one-shot `boss-recommend-mcp run`. `src/cli.js` no longer lazy-loads `src/pipeline.js` for this command; it returns structured `RECOMMEND_CLI_RUN_UNSUPPORTED_CDP_ONLY` with `cdp_only=true`, `runtime_evaluate_used=false`, and empty `method_log`. Commands `node src\cli.js run --instruction 'CDP-only package gate' --port 9222` and `node bin\boss-recommend-mcp.js run --instruction 'CDP-only package gate' --port 9222` both exited `1` intentionally, performed no browser interaction, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- 2026-05-01 22:36 Asia/Shanghai: fourteenth quarantine slice verified for MCP featured calibration. `get_featured_calibration_status` now uses pure config/filesystem resolution from `src/chat-runtime-config.js`; `run_featured_calibration` returns structured `FEATURED_CALIBRATION_UNSUPPORTED_CDP_ONLY` with empty `method_log` until a CDP-only safe-action calibration gate exists. Artifacts: `.live-artifacts\mcp-featured-calibration-status-phase9-pure.json` and `.live-artifacts\mcp-featured-calibration-run-phase9-fenced.json`.
- 2026-05-01 22:39 Asia/Shanghai: fifteenth quarantine slice live-verified for MCP recommend self-heal. `run_recommend_self_heal` scan now connects to Chrome 9222 through shared CDP browser helpers and runs `src/core/self-heal` probes; live result was `status=OK`, recommend health `healthy`, candidate card count 15, AX node count 163, and no `Runtime.*`. Apply mode is fenced with `RECOMMEND_SELF_HEAL_APPLY_UNSUPPORTED_CDP_ONLY`. Artifacts: `.live-artifacts\mcp-recommend-self-heal-phase9-cdp-live.json` and `.live-artifacts\mcp-recommend-self-heal-apply-phase9-fenced.json`.
- 2026-05-01 22:41 Asia/Shanghai: sixteenth quarantine slice package-entrypoint verified for detached legacy worker fencing. `src/index.js` no longer lazy-loads `src/pipeline.js`; a detached worker without a test-injected implementation fails closed with `DETACHED_LEGACY_PIPELINE_UNSUPPORTED_CDP_ONLY` and updates the run snapshot to `failed`. Artifact: `.live-artifacts\detached-worker-phase9-fenced.json`.
- 2026-05-02 10:36 Asia/Shanghai: seventeenth quarantine slice package-entrypoint verified for package publish-surface narrowing. `package.json#files` now excludes package-local quarantined legacy code and vendors, `scripts/scan-forbidden-runtime.js` supports `--package-surface`, and `src/test-runtime-scan.js` asserts package strict mode. `src/cli.js` `doctor` treats legacy vendor checks as optional and validates package-root dependencies instead. `npm run scan:runtime:package:strict` passed with 0 raw non-allowed findings and `npm pack --dry-run --json` wrote `.live-artifacts\package-dry-run-phase9.json` with 49 files and 0 blocked/quarantined paths. A tarball install smoke under `.live-artifacts\package-install-phase9` verified `node_modules\@reconcrap\boss-recommend-mcp\bin\boss-recommend-mcp.js doctor --port 9222 --page-scope recommend --slow-live` passed, target `https://www.zhipin.com/web/chat/recommend`, and no `Runtime.*`.
- 2026-05-02 10:52 Asia/Shanghai: eighteenth quarantine slice verified for research-only legacy separation. Package-local legacy modules, legacy tests, and vendor automation moved intact to `legacy/research/`; `legacy/README.md` declares the folder research-only; active npm scripts no longer reference legacy tests or package-local vendor tools; `.npmignore` excludes `legacy/` and `vendor/`; scanner quarantine now covers `legacy/research/`. `npm run scan:runtime:strict` still passed with 0 reachable active findings, 457 research/external-source legacy findings, and 2 allowed guard references. `npm run scan:runtime:package:strict` still passed with 0 raw non-allowed package-surface findings.
- 2026-05-02 11:06 Asia/Shanghai: nineteenth quarantine slice verified for active boundary enforcement. Added `scripts/scan-legacy-boundary.js` and `npm run scan:legacy-boundary`; `src/test-runtime-scan.js` now asserts the boundary scan. `src/cli.js` `doctor` no longer checks package-local legacy recommend search/screen vendor directories or entry files. Recommend live smoke scripts now default to shared CDP-only self-heal fallback selectors instead of the moved `recommend-healing-rules.json`. `npm run scan:legacy-boundary` scanned 81 active files with 0 findings; `npm run live:self-heal -- --skip-refresh-repair --save-report .live-artifacts\self-heal-phase9-boundary-default-rules-live.json` passed against recommend with 15 cards and no `Runtime.*`; installed package doctor under `.live-artifacts\package-install-phase9-boundary` passed with no `legacy/` or `vendor/` package directories.
- 2026-05-02 11:12 Asia/Shanghai: twentieth quarantine slice verified for final research archive policy and package boundary. Added `docs/LEGACY_ARCHIVE_POLICY.md`, `legacy/research/README.md`, and `scripts/scan-package-boundary.js`; `docs/SESSION_START.md` now requires reading the policy and running boundary scanners. Policy is to keep `legacy/research/` in-repo as inert research archive. `npm run scan:package-boundary` used real `npm pack --dry-run --json`, found 49 package entries and 0 findings. Installed package doctor under `.live-artifacts\package-install-phase9-archive-policy` passed with no `legacy/`, `vendor/`, `docs/`, live scripts, or scanner scripts in the installed package.
- 2026-05-02 11:14 Asia/Shanghai: twenty-first quarantine slice verified for aggregate Phase 9 static gate. Added `scripts/phase9-static-gate.js` and `npm run gate:phase9-static`; the aggregate gate passed runtime strict, package runtime strict, legacy boundary, and package boundary. Installed package doctor under `.live-artifacts\package-install-phase9-static-gate` passed with no archived/development-only directories in the installed package and no `Runtime.*`.

## Rules

- `legacy-active` means the code exists and is considered reachable by the scanner's active package-entrypoint gate.
- `legacy-quarantined` means the code still exists and is explicitly fenced as research-only legacy code, an external migration reference, or a compatibility reference. It is not an active runtime path and must not be imported by package code.
- `rewritten` means the behavior is implemented in CDP-only modules.
- `removed` means the legacy source no longer exists in this project.

The scanner strict gate requires all active runtime paths to be `rewritten`, `removed`, or `legacy-quarantined`. Final Phase 9 completion still requires a policy decision on whether `legacy/research/` remains in-repo as a research archive or moves to a separate non-package archive location.
