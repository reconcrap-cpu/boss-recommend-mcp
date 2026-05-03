# Boss MCP Rewrite Execution Plan With Live Gates

## Summary

The unified Boss MCP project will own recommend, recruit, and chat workflows. Shared layers must provide CDP-only browser access, run lifecycle, screening, and self-heal. Domain modules must be thin, independently testable implementations on top of those shared layers.

Mock tests are never sufficient for completion. Each module moves through `dev-ready`, `live-verified`, then `complete`.

Reporting compatibility is part of completion for recommend, search/recruit, and chat. Finished runs must emit legacy-compatible two-section CSV files: user input fields first, then candidate results. Candidate screening prompts must request only a boolean JSON decision (`{"passed": true/false}`) and must not ask the LLM for reasons or evidence. CSV `评估通过详细原因` stays blank; CSV `判断依据(CoT)` records provider-returned reasoning/Cot/raw model output when present.

## Phase 0: Baseline, Inventory, And Live Harness

Status target: `complete`.

Tasks:

- Create rewrite docs and session handoff files.
- Inventory active `Runtime.evaluate` and page-JS usage in recommend, recruit, chat, and vendor paths.
- Add scanner for forbidden runtime/page-JS patterns.
- Add live CDP harness for the logged-in Chrome instance on port `9222`.
- Harness must record every CDP method used and block `Runtime.*`.

Live gate:

- Connect to Chrome on port `9222`.
- Select the Boss recommend tab.
- Prove the guard blocks `Runtime.evaluate` before transport.
- Record method log with no `Runtime.*`.

## Phase 1: `core/browser` CDP-Only Layer

Status target: `complete`.

Tasks:

- Implement target discovery and guarded CDP connection.
- Implement iframe discovery through `DOM.describeNode(...contentDocument)`.
- Implement selector, attributes, outer HTML, box model, click, key, and Accessibility helpers.
- Keep all domain browser access behind this layer.

Live gate:

- Locate `https://www.zhipin.com/web/chat/recommend`.
- Locate `iframe[name="recommendFrame"]`.
- Query `.filter-label-wrap`.
- Calculate center with `DOM.getBoxModel`.
- Click with `Input.dispatchMouseEvent`.
- Verify `.filter-panel` mounts using CDP DOM only.

## Phase 1.5: `core/infinite-list` CDP-Only Layer

Status target: `live-verified`.

Starts after Phase 1 is live-verified. Recommend, recruit/search, and chat all expose infinite candidate lists, so domain runs must not stop at the first mounted card batch or use raw visible indexes as the identity contract.

Tasks:

- Implement a shared cursor for mounted candidate cards using CDP `DOM` reads and `Input` scrolling only.
- Track `seen`, `queued`, and `processed` candidate keys so candidates are not missed or screened twice between scrolls.
- Build stable candidate keys from domain id plus text fingerprint where possible, with attribute/identity/text fallbacks.
- Detect list end by repeated stable visible signatures after scroll attempts, not by mock counts.
- Scroll with `DOM.scrollIntoViewIfNeeded` plus `Input.dispatchMouseEvent` wheel events.
- Support fallback wheel points for pages like chat where list items may remount between discovery and scroll.
- Record read errors, skipped duplicate counts, scroll counts, end reasons, and final list state in run summaries.
- Preserve `processed`/`seen` de-duplication across refreshed rounds while resetting transient visible-list cursor state after a CDP-only refresh or reload.
- Wire recommend and recruit/search run services to use the shared cursor before increasing `processed`.
- Chat run service must consume the same cursor before increasing `processed`, just like recommend and recruit/search.

Live gate:

- Run `npm run live:infinite-list -- --domain recommend --slow-live --target-unique 36 --max-scrolls-per-candidate 6 --save-report .live-artifacts\recommend-infinite-list-scroll-live.json`.
- Run `npm run live:infinite-list -- --domain recruit --slow-live --target-unique 18 --max-scrolls-per-candidate 4 --save-report .live-artifacts\recruit-infinite-list-keyed-live.json`.
- Run `npm run live:infinite-list -- --domain chat --slow-live --target-unique 45 --max-scrolls-per-candidate 4 --save-report .live-artifacts\chat-infinite-list-fallback-wheel-live.json`.
- Each live result must show no duplicate processed keys and no `Runtime.*` methods.
- Mock/unit tests support development only; they do not complete the layer without the live gates above.

## Phase 2: `core/run` Lifecycle Layer

Can develop in parallel with Phase 3 after Phase 1 interfaces are stable.

Tasks:

- Implement shared start/status/pause/resume/cancel/checkpoint/cleanup/progress.
- Migrate existing recommend and recruit run state into the shared contract.

Live gate:

- Start a short recommend-connected run.
- Pause while browser work is active.
- Verify no further candidate action while paused.
- Resume, then cancel.
- Verify cleanup and final status.

## Phase 3: `core/screening` Shared CV Layer

Can develop in parallel with Phase 2.

Tasks:

- Normalize candidate/resume inputs from recommend, recruit, and chat.
- Share screening criteria, scoring, skip reasons, LLM prompt/result handling, and result formatting.

Live gate:

- Screen at least one live candidate from each supported domain.
- Missing live access blocks that domain adapter rather than passing it.

## Phase 4: `core/self-heal` Shared Layer

Starts after Phase 1 is live-verified.

Tasks:

- Build config-driven probes, drift reports, repair actions, and repair summaries.
- Domain modules register recommend, recruit, and chat probe configs.
- Add a shared viewport-collapse probe copied from the legacy recommend thresholds: absolute body/frame/viewport minimums plus relative collapse detection when a near-fullscreen Chrome window exposes a much smaller content viewport.
- Viewport recovery must use CDP only: `Page.getLayoutMetrics`, `DOM.getBoxModel`, and `Browser.getWindowForTarget` / `Browser.getWindowBounds` / `Browser.setWindowBounds`. It must never use page JS or `Runtime.evaluate`.
- Recommend, recruit/search, and chat run services must auto-run the viewport guard at startup, before card discovery, inside candidate-loop node refreshes, after refresh/reload rounds, and before detail extraction. If recovery fails, fail the run with `LIST_VIEWPORT_COLLAPSED` instead of continuing against a broken viewport.

Live gate:

- Run recommend health check against live recommend.
- Run recruit and chat health checks when those pages are available.
- Run short live recommend, recruit/search, and chat run-service smokes and verify run summaries include `viewport_health.stats`, `viewport_checks`, and no `Runtime.*` methods. A mock-only viewport guard is only `dev-ready`.
- Report unavailable pages as blockers, not passes.

## Phase 5: Recommend Domain Rewrite

Starts after Phases 1 and 2 are live-verified.

Tasks:

- Rewrite recommend filters, candidate discovery, card parsing, detail/resume extraction, favorite/greet preparation, and probes.
- Support recommend page scopes `推荐`, `精选`, and `最新` through CDP-only DOM tab discovery and `Input` clicks. Scope selection must happen after job selection because not every job exposes every scope.
- If a requested recommend page scope is unavailable for the selected job, fall back to `推荐`, record `fallback_applied=true`, and continue the run instead of failing.
- Treat multi-group and multi-label filters as first-class behavior for normal runs and refresh rounds.
- If target count is not met after reaching the recommend list end, first click the bottom `刷新` button CDP-only; if that is unavailable or fails, reload and reapply the same filters.
- During every refreshed recommend round, force the `recentNotView / 近14天没有` filter regardless of the user's original input so refreshed results avoid recently viewed candidates.
- Remove or quarantine recommend legacy automation that still uses page JS.

Live gate:

- Select a safe non-active filter CDP-only.
- Select each available recommend page scope (`推荐`, `精选`, `最新`) on a selected live job and complete a short run.
- Verify unavailable-scope fallback to `推荐` whenever a live selected job lacks the requested scope; if the selected job exposes all scopes, record that live condition and keep fallback covered by regression tests until a missing-scope role is available.
- Confirm panel closes and candidate counts refresh.
- Extract live cards and screen live candidates.
- Exercise pause/resume/cancel.

## Phase 6: Recruit Domain Import And Rewrite

Starts after Phases 1 and 2 are live-verified.

Tasks:

- Import behavior from `C:\Users\yaolin\Documents\codex_projects\boss recruit pipeline\boss-recruit-mcp`.
- Preserve recruit MCP tool semantics.
- Rewrite search/screen browser automation with CDP-only primitives.
- Treat search filters as multi-select capable where the live UI permits it, including repeated degree inputs and multiple school labels.
- If target count is not met after reaching search list end, refresh/reload the search page and reapply the exact same keyword, city, degree, school, and other filters.
- During every refreshed search round, force `filter_recent_viewed=true` regardless of the user's original input.

Live gate:

- Extract live recruit/search candidates CDP-only.
- Extract one live profile/resume source through DOM/AX/Network.
- Run shared screening and lifecycle controls.

## Phase 7: Chat Domain Rewrite

Starts after Phases 1, 2, and 3 are live-verified.

Tasks:

- Rewrite chat list/profile discovery, screening, outreach preparation, and probes.
- Replace chat runtime wrappers that use page JS.
- Use `core/infinite-list` for chat candidate traversal so scrolls do not miss or double-screen candidates.
- Use `core/run` for direct chat start/status/pause/resume/cancel before adding MCP wrappers.
- Keep lifecycle live tests non-mutating: selecting a conversation and opening online resume is allowed for extraction gates, but outreach/send-message actions require a separate explicit safe-action gate.

Live gate:

- Locate live chat page/list/profile CDP-only.
- Extract one live profile.
- Run shared screening and lifecycle controls.
- Direct run-service gate: `npm run live:chat-run-service -- --slow-live --max-candidates 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --save-report .live-artifacts\chat-run-service-lifecycle-live.json`.

## Phase 8: MCP API Integration

Starts once at least one domain is live-verified; completion waits for all domains.

Tasks:

- Make MCP handlers thin wrappers over shared services.
- Preserve recommend tools.
- Add a read-only recommend job-list helper for cron/one-shot setup: MCP `list_recommend_jobs` and CLI `boss-recommend-mcp list-jobs` must read the recommend job dropdown CDP-only and return exact `job_names` without starting a run.
- Route recommend `post_action=favorite/greet` through the shared CDP-only recommend detail action gate. The MCP route must support non-mutating dry-run validation, explicit execution flags, greet quota safeguards, and no `Runtime.*`.
- Keep recommend `follow_up.chat` out of the CDP-only rewrite. This chained orchestration is legacy-only by decision; active MCP should fail closed instead of treating it as a remaining Phase 8 blocker.
- Add recruit tools: `run_recruit_pipeline`, `start_recruit_pipeline_run`, `get_recruit_pipeline_run`, `cancel_recruit_pipeline_run`, `pause_recruit_pipeline_run`, `resume_recruit_pipeline_run`.
- Route chat lifecycle tools through `src/chat-mcp.js` and `createChatRunService`: `start_boss_chat_run`, `get_boss_chat_run`, `pause_boss_chat_run`, `resume_boss_chat_run`, `cancel_boss_chat_run`. `prepare_boss_chat_run` now reads the live chat job list CDP-only through `src/domains/chat/jobs.js`; `boss_chat_health_check` now runs CDP-only chat self-heal probes and shared config/runtime checks through `src/chat-mcp.js`.

Live gate:

- Call recommend, recruit, and chat tools against live Chrome.
- Verify MCP behavior matches direct domain behavior.
- Recommend MCP lifecycle live gate passed on 2026-05-01 20:47 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-lifecycle-live.json`; final status `canceled`, 2 live recommend card candidates processed, no `Runtime.*`.
- Recommend MCP safe-action dry-run gate passed on 2026-05-03 10:22 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --target-count 1 --detail-limit 0 --delay-ms 500 --complete-without-cancel --post-action greet --max-greet-count 1 --dry-run-post-action --no-filter --timeout-ms 600000 --save-report .live-artifacts\recommend-mcp-safe-action-dry-run-live-20260503-1015.json`; final status `completed`, discovered live `打招呼` selector `button.btn-v2.btn-sure-v2.btn-greet`, recorded `would_click=true`, clicked nothing, and used no `Runtime.*`.
- Recommend MCP safe-action mutating gate passed on 2026-05-03 10:31 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --target-count 2 --detail-limit 0 --delay-ms 500 --complete-without-cancel --post-action greet --max-greet-count 1 --execute-post-action --no-filter --timeout-ms 600000 --save-report .live-artifacts\recommend-mcp-safe-action-greet-verified-live-20260503-1032.json`; final status `completed`, clicked one live `打招呼`, post-click CDP discovery saw `继续沟通`, and no `Runtime.*` methods were used.
- Recommend MCP safe-action favorite gate passed on 2026-05-03 15:38 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --target-count 1 --detail-limit 0 --delay-ms 500 --complete-without-cancel --post-action favorite --execute-post-action --no-filter --timeout-ms 600000 --save-report .live-artifacts\recommend-mcp-safe-action-favorite-live-20260503-1538.json`; final status `completed`, clicked one live `收藏`, post-click CDP discovery saw `已收藏`, and no `Runtime.*` methods were used.
- Recommend MCP page-scope gate passed on 2026-05-03 15:53 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --job "算法工程师 23-27届实习/校招/早期职业 _ 杭州" --page-scope recommend|featured|latest --target-count 1 --detail-limit 1 --delay-ms 500 --complete-without-cancel --post-action none --no-filter --timeout-ms 900000`; the selected job exposed all three scopes, each run completed with `processed=1`, `screened=1`, `detail_opened=1`, effective scope matching request, and no `Runtime.*`.
- Recommend Phase 10 page-scope full-flow spot checks passed on 2026-05-03 15:58-15:59 Asia/Shanghai with `npm run live:recommend-phase10-full -- --slow-live --job "算法工程师 23-27届实习/校招/早期职业 _ 杭州" --page-scope recommend|featured|latest --target-count 1 --max-screened 1 --post-action none --dry-run-post-action --delay-ms 500 --llm-timeout-ms 480000`; each run selected the requested scope, confirmed filters, opened one detail, captured Network CV, called the configured LLM, wrote CSV, and used no `Runtime.*`.
- Recommend job-list helper passed on 2026-05-03 16:04-16:05 Asia/Shanghai with `node src\cli.js list-jobs --slow-live --port 9222` and a direct MCP `tools/call` for `list_recommend_jobs`; both returned 7 live recommend job names, selected current job metadata, and no `Runtime.*`.
- Chat MCP lifecycle live gate passed on 2026-05-01 20:34 Asia/Shanghai with `npm run live:chat-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --save-report .live-artifacts\chat-mcp-lifecycle-live.json`; final status `canceled`, 2 live card candidates processed, no `Runtime.*`.

## Phase 9: Legacy Removal And Hard Static Gate

Starts after domain rewrites are live-verified.

Tasks:

- Delete or quarantine active legacy modules containing forbidden APIs.
- Convert scanner into a hard test for active runtime paths.
- First quarantine slices should peel pure helpers out of legacy modules before fencing the legacy browser automation. Completed first slice: chat runtime-path and target-count helpers moved to `src/chat-runtime-config.js`; `start_boss_chat_run` missing-input handling no longer calls legacy chat prepare.
- Completed second slice: `src/index.js` no longer statically imports legacy adapters/chat/pipeline/self-heal; these are lazy-loaded only for legacy calibration/self-heal/prepare/detached-worker paths.
- Completed third slice: `src/cli.js` no longer statically imports legacy adapters/chat/pipeline; these are lazy-loaded only for legacy CLI command paths.
- Completed fourth slice: `scripts/scan-forbidden-runtime.js` distinguishes raw non-allowed findings from reachable active findings, marks explicitly fenced legacy code as `legacy-quarantined`, records quarantine reasons, and makes `npm run scan:runtime:strict` fail only when reachable active findings remain. Raw legacy debt remains visible through `raw_active_findings`, `legacy_quarantined_findings`, and `--fail-on-legacy`.
- Completed fifth slice: `prepare_boss_chat_run` no longer imports or calls legacy chat prepare. Chat job options are read through CDP DOM selectors in `src/domains/chat/jobs.js`, and the MCP prepare route records method logs with the same Runtime guard as lifecycle runs.
- Completed sixth slice: `boss_chat_health_check` no longer imports or calls legacy chat health. Health uses `src/chat-mcp.js`, shared chat self-heal probes, and non-legacy shared config/runtime path resolution in `src/chat-runtime-config.js`.
- Completed seventh slice: `boss-recommend-mcp chat ...` no longer imports or lazy-loads `src/boss-chat.js`. `health-check` and `prepare-run` are CDP-only CLI wrappers over `src/chat-mcp.js`, chat runtime path setup uses `src/chat-runtime-config.js`, status/control subcommands use CDP-only run snapshots/service APIs, and `run/start-run` are fenced with `CHAT_CLI_ASYNC_UNSUPPORTED_CDP_ONLY` because a one-shot CLI process cannot keep an active CDP run alive after exit.
- Completed eighth slice: `boss-recommend-mcp where` no longer imports or lazy-loads `src/adapters.js`; it resolves package/config/chat runtime/calibration paths through pure filesystem helpers and `src/chat-runtime-config.js`.
- Completed ninth slice: CLI config target helpers no longer import or lazy-load `src/adapters.js`; `src/chat-runtime-config.js` exports the pure `getBossScreenConfigResolution()`, and `init-config`, `config set`, and `set-port` use it for target selection.
- Completed tenth slice: `boss-recommend-mcp launch-chrome` no longer imports or lazy-loads `src/adapters.js`; it reuses/opens Boss recommend tabs with local DevTools/CDP helpers, verifies `iframe[name="recommendFrame"]` through CDP DOM, and records guarded CDP methods.
- Completed eleventh slice: `boss-recommend-mcp doctor` no longer imports or lazy-loads `src/adapters.js`; it builds preflight checks from pure filesystem/config/dependency helpers and verifies recommend readiness through the CDP-only page inspector.
- Completed twelfth slice: `boss-recommend-mcp calibrate` no longer imports or lazy-loads `src/adapters.js`; legacy calibration is fenced with `CALIBRATE_UNSUPPORTED_CDP_ONLY` until a CDP-only featured calibration flow has a user-approved live gate.
- Completed thirteenth slice: `boss-recommend-mcp run` no longer imports or lazy-loads `src/pipeline.js`; the legacy one-shot recommend CLI path is fenced with `RECOMMEND_CLI_RUN_UNSUPPORTED_CDP_ONLY` until a durable CDP-only one-shot replacement is live-verified.
- Completed fourteenth slice: MCP featured calibration status now uses pure config/filesystem resolution; `run_featured_calibration` is fenced with `FEATURED_CALIBRATION_UNSUPPORTED_CDP_ONLY` until a CDP-only safe-action calibration gate exists.
- Completed fifteenth slice: MCP `run_recommend_self_heal` scan now runs shared CDP-only recommend self-heal probes live; apply mode is fenced with `RECOMMEND_SELF_HEAL_APPLY_UNSUPPORTED_CDP_ONLY`.
- Completed sixteenth slice: detached legacy recommend workers no longer import `src/pipeline.js`; without a test-injected implementation they fail closed with `DETACHED_LEGACY_PIPELINE_UNSUPPORTED_CDP_ONLY`.
- Completed seventeenth slice: `package.json#files` now narrows the npm publish surface to CDP-only entrypoints and shared/domain modules, excluding local quarantined legacy modules and vendors from published packages. `scripts/scan-forbidden-runtime.js` supports `--package-surface`, `npm run scan:runtime:package:strict` is a hard gate for the publish surface, and `doctor` no longer requires excluded legacy vendor directories.
- Completed eighteenth slice: package-local legacy modules, legacy tests, and vendor automation are physically separated under `legacy/research/` for research only. Active npm scripts no longer reference legacy tests/vendors, `.npmignore` excludes `legacy/` and `vendor/`, and the scanner inventories `legacy/research/` as quarantined research code while package-surface strict mode remains clean.
- Completed nineteenth slice: `scripts/scan-legacy-boundary.js` now hard-fails active `bin/`, `src/`, package scripts/files, and live scripts if they reference `legacy/research/`, package-local Boss vendor paths, or moved legacy modules/tests/rules. `src/cli.js` doctor no longer checks package-local legacy vendor directories at all, and recommend live smoke scripts now default to the shared CDP-only self-heal selector fallbacks instead of the moved legacy rules file.
- Completed twentieth slice: the final research-archive policy is now explicit. `legacy/research/` stays in-repo as a research-only archive, `docs/LEGACY_ARCHIVE_POLICY.md` defines the rules, `docs/SESSION_START.md` requires future sessions to read that policy and run the boundary scanners, and `scripts/scan-package-boundary.js` hard-fails if `npm pack --dry-run --json` includes legacy archives, package-local vendors, docs, live/scanner scripts, or development tests.
- Completed twenty-first slice: `scripts/phase9-static-gate.js` and `npm run gate:phase9-static` aggregate the Phase 9 hard static gates: runtime strict, package runtime strict, legacy boundary, and package boundary.

Live gate:

- Rerun live smoke tests after legacy removal.
- Prove package entrypoints still work.
- First slice gate passed on 2026-05-01 20:58 Asia/Shanghai with `npm run live:chat-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --timeout-ms 480000 --save-report .live-artifacts\chat-mcp-phase9-helper-split-live.json`; final status `canceled`, 2 live chat card candidates processed, method count 250, no `Runtime.*`.
- Second slice gate passed on 2026-05-01 21:01 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-phase9-index-lazy-live.json`; final status `canceled`, 2 live recommend card candidates processed, method count 218, no `Runtime.*`.
- Third slice gate passed on 2026-05-01 21:08 Asia/Shanghai with `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-phase9-cli-lazy-live.json`; final status `canceled`, 2 live recommend card candidates processed, method count 217, no `Runtime.*`.
- Fourth slice gate passed on 2026-05-01 21:17 Asia/Shanghai with `npm run scan:runtime`, `npm run scan:runtime:strict`, `npm run test:runtime-scan`, and `npm run live:recommend-mcp -- --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --no-filter --timeout-ms 480000 --save-report .live-artifacts\recommend-mcp-phase9-scanner-aware-live.json`; scanner strict gate reported 0 reachable active findings, 457 legacy-quarantined findings, and 2 allowed guard references. Live recommend MCP run `mcp_recommend_momxt58u_0jjsam3l` processed 2 live recommend card candidates, final status `canceled`, method count 217, no `Runtime.*`.
- Fifth slice gate passed on 2026-05-01 21:28 Asia/Shanghai with `npm run live:chat-mcp -- --prepare-first --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --timeout-ms 480000 --save-report .live-artifacts\chat-mcp-phase9-prepare-cdp-live.json`; prepare returned `NEED_INPUT`, found 9 job options from `.chat-job .ui-dropmenu-list li`, selected label `全部职位`, then live chat MCP run `mcp_chat_momy7hpq_4r039ioi` processed 2 live chat candidates, final status `canceled`, method count 249, no `Runtime.*`.
- Sixth slice gate passed on 2026-05-01 21:40 Asia/Shanghai with `npm run live:chat-mcp -- --health-first --prepare-first --slow-live --target-count 8 --detail-limit 0 --delay-ms 1600 --pause-after-processed 1 --timeout-ms 480000 --save-report .live-artifacts\chat-mcp-phase9-health-cdp-live.json`; health returned `OK`, resolved shared config, observed 40 chat cards and 1,368 AX nodes through CDP-only self-heal probes, then live chat MCP run `mcp_chat_momyn52n_reb7bjag` processed 2 live chat candidates, final status `canceled`, method count 249, no `Runtime.*`.
- Seventh slice gate passed on 2026-05-01 21:52 Asia/Shanghai with `node src\cli.js chat health-check --slow-live --port 9222` and `node src\cli.js chat prepare-run --slow-live --port 9222`; health returned `OK`, observed 40 chat cards and 1,368 AX nodes, prepare returned `NEED_INPUT` with 9 live job options from `.chat-job .ui-dropmenu-list li`, selected label `全部职位`, artifacts `.live-artifacts\chat-cli-phase9-health-cdp-live.json` and `.live-artifacts\chat-cli-phase9-prepare-cdp-live.json` recorded 0 `Runtime.*` methods. `node src\cli.js chat start-run --job test --start-from all --criteria test --target-count 1` returned the expected fenced `CHAT_CLI_ASYNC_UNSUPPORTED_CDP_ONLY` response.
- Eighth slice package-entrypoint gate passed on 2026-05-01 22:00 Asia/Shanghai with `node src\cli.js where`; output artifact `.live-artifacts\cli-where-phase9-pure-paths.txt` resolved the Boss chat runtime under `C:\Users\yaolin\.boss-recommend-mcp\boss-chat`, the calibration target under `C:\Users\yaolin\.codex\boss-recommend-mcp\favorite-calibration.json`, and the recruit calibration script under the imported source tree. `npm run scan:runtime:strict` still reported 0 reachable active findings.
- Ninth slice package-entrypoint gate passed on 2026-05-01 22:06 Asia/Shanghai with an isolated temp `BOSS_RECOMMEND_SCREEN_CONFIG` and temp `BOSS_RECOMMEND_HOME`: `node src\cli.js init-config --workspace-root <temp-workspace>`, `node src\cli.js config set --workspace-root <temp-workspace> --base-url https://api.example.com/v1 --api-key sk-temp-config-test --model gpt-4.1-mini --thinking-level low`, and `node src\cli.js set-port --workspace-root <temp-workspace> --port 9222` all passed. Summary artifact `.live-artifacts\cli-config-phase9-summary.json` confirmed `debugPort=9222`, and `npm run scan:runtime:strict` still reported 0 reachable active findings.
- Tenth slice live/package-entrypoint gate passed on 2026-05-01 22:13 Asia/Shanghai with `node src\cli.js launch-chrome --port 9222 --slow-live` and `node bin\boss-recommend-mcp.js launch-chrome --port 9222 --slow-live`; both commands reused Chrome `127.0.0.1:9222`, verified `https://www.zhipin.com/web/chat/recommend`, brought the tab forward, logged CDP methods `Page.enable` and `Page.bringToFront`, and used no `Runtime.*` methods. Artifacts: `.live-artifacts\cli-launch-chrome-phase9-cdp.txt` and `.live-artifacts\bin-launch-chrome-phase9-cdp.txt`.
- Eleventh slice live/package-entrypoint gate passed on 2026-05-01 22:21 Asia/Shanghai with `node src\cli.js doctor --port 9222 --page-scope recommend --slow-live` and `node bin\boss-recommend-mcp.js doctor --port 9222 --page-scope recommend --slow-live`; both commands returned `ok=true`, verified `https://www.zhipin.com/web/chat/recommend`, detected the recommend iframe, logged CDP methods `Page.enable`, `DOM.enable`, `DOM.getDocument`, `DOM.querySelector`, and `DOM.describeNode`, and used no `Runtime.*` methods. Artifacts: `.live-artifacts\cli-doctor-phase9-cdp-live.json` and `.live-artifacts\bin-doctor-phase9-cdp-live.json`.
- Twelfth slice package-entrypoint gate passed on 2026-05-01 22:25 Asia/Shanghai with `node src\cli.js calibrate --port 9222 --timeout-ms 5000` and `node bin\boss-recommend-mcp.js calibrate --port 9222 --timeout-ms 5000`; both commands intentionally exited `1`, returned `CALIBRATE_UNSUPPORTED_CDP_ONLY`, recorded `cdp_only=true`, `runtime_evaluate_used=false`, empty `method_log`, and no browser interaction. Artifacts: `.live-artifacts\cli-calibrate-phase9-fenced.txt` and `.live-artifacts\bin-calibrate-phase9-fenced.txt`.
- Thirteenth slice package-entrypoint gate passed on 2026-05-01 22:31 Asia/Shanghai with `node src\cli.js run --instruction 'CDP-only package gate' --port 9222` and `node bin\boss-recommend-mcp.js run --instruction 'CDP-only package gate' --port 9222`; both commands intentionally exited `1`, returned `RECOMMEND_CLI_RUN_UNSUPPORTED_CDP_ONLY`, recorded `cdp_only=true`, `runtime_evaluate_used=false`, empty `method_log`, and no browser interaction. Artifacts: `.live-artifacts\cli-run-phase9-fenced.txt` and `.live-artifacts\bin-run-phase9-fenced.txt`.
- Fourteenth slice MCP gate passed on 2026-05-01 22:36 Asia/Shanghai with direct `handleRequest` calls for `get_featured_calibration_status` and `run_featured_calibration`; status returned the existing calibration file and script path, while run returned `FEATURED_CALIBRATION_UNSUPPORTED_CDP_ONLY`, `cdp_only=true`, `runtime_evaluate_used=false`, empty `method_log`, and no browser interaction. Artifacts: `.live-artifacts\mcp-featured-calibration-status-phase9-pure.json` and `.live-artifacts\mcp-featured-calibration-run-phase9-fenced.json`.
- Fifteenth slice live MCP gate passed on 2026-05-01 22:39 Asia/Shanghai with `run_recommend_self_heal` scan through `handleRequest` against Chrome `127.0.0.1:9222`; recommend health was `healthy`, iframe/filter/cards/tabs/AX probes passed, candidate card count was 15, AX node count was 163, and no `Runtime.*` methods were used. Apply mode returned `RECOMMEND_SELF_HEAL_APPLY_UNSUPPORTED_CDP_ONLY`. Artifacts: `.live-artifacts\mcp-recommend-self-heal-phase9-cdp-live.json` and `.live-artifacts\mcp-recommend-self-heal-apply-phase9-fenced.json`.
- Sixteenth slice package-entrypoint gate passed on 2026-05-01 22:41 Asia/Shanghai with an isolated detached-worker run snapshot under `.live-artifacts\detached-worker-phase9-home`; the worker wrote `DETACHED_LEGACY_PIPELINE_UNSUPPORTED_CDP_ONLY`, marked the snapshot `failed`, and did not import `src/pipeline.js`. Artifact: `.live-artifacts\detached-worker-phase9-fenced.json`.
- Seventeenth slice package-entrypoint gate passed on 2026-05-02 10:36 Asia/Shanghai with `npm run scan:runtime:package`, `npm run scan:runtime:package:strict`, `npm pack --dry-run --json > .live-artifacts\package-dry-run-phase9.json`, a blocked-path assertion over the dry-run package listing, `node bin\boss-recommend-mcp.js doctor --port 9222 --page-scope recommend --slow-live`, and a tarball install smoke from `.live-artifacts\package-install-phase9`. Package strict mode reported 2 allowed guard findings, 0 raw non-allowed findings, 0 legacy-quarantined findings, and 0 reachable active findings; npm dry-run listed 49 files and 0 blocked/quarantined paths; installed-package doctor passed with 4 absent legacy vendor checks marked optional; live doctor verified `https://www.zhipin.com/web/chat/recommend` with `Page.enable`, `DOM.enable`, `DOM.getDocument`, `DOM.querySelector`, and `DOM.describeNode`, and no `Runtime.*`.
- Eighteenth slice package-entrypoint gate passed on 2026-05-02 10:52 Asia/Shanghai with physical moves to `legacy/research/`, `npm run scan:runtime`, `npm run scan:runtime:strict`, `npm run scan:runtime:package:strict`, and `npm run test:runtime-scan`. Repo strict mode reported 0 reachable active findings, 457 legacy-quarantined research/external-source findings, and 2 allowed guard findings. Package strict mode reported 0 raw non-allowed package findings. Active package scripts no longer reference legacy tests or package-local vendor tools.
- Nineteenth slice live/package-entrypoint gate passed on 2026-05-02 11:06 Asia/Shanghai with `npm run scan:legacy-boundary`, `npm run test:runtime-scan`, `npm run scan:runtime`, `npm run scan:runtime:strict`, `npm run scan:runtime:package:strict`, `npm pack --dry-run --json`, `node bin\boss-recommend-mcp.js doctor --port 9222 --page-scope recommend --slow-live`, `npm run live:self-heal -- --skip-refresh-repair --save-report .live-artifacts\self-heal-phase9-boundary-default-rules-live.json`, and an installed tarball doctor smoke from `.live-artifacts\package-install-phase9-boundary`. Boundary scan reported 81 active files and 0 findings; npm dry-run still listed 49 package files and 0 blocked paths; installed package had no `legacy/` or `vendor/`; live doctor verified `https://www.zhipin.com/web/chat/recommend` with no `Runtime.*`; self-heal passed using fallback CDP selector config with 15 candidate cards.
- Twentieth slice live/package-entrypoint gate passed on 2026-05-02 11:12 Asia/Shanghai with `npm run scan:package-boundary`, `npm run test:runtime-scan`, `npm run scan:runtime`, `npm run scan:runtime:strict`, `npm run scan:runtime:package:strict`, `npm run scan:legacy-boundary`, `npm pack --dry-run --json`, and an installed tarball doctor smoke from `.live-artifacts\package-install-phase9-archive-policy`. Package boundary reported 49 entries and 0 findings; the installed package had no `legacy/`, `vendor/`, `docs/`, live scripts, or scanner scripts; live doctor verified `https://www.zhipin.com/web/chat/recommend` and used no `Runtime.*`.
- Twenty-first slice live/package-entrypoint gate passed on 2026-05-02 11:14 Asia/Shanghai with `npm run gate:phase9-static`, `npm run test:runtime-scan`, `npm pack --dry-run --json`, and an installed tarball doctor smoke from `.live-artifacts\package-install-phase9-static-gate`. Aggregate static gate ran all 4 gates and passed; npm dry-run listed 49 entries and 0 blocked paths; installed package had no `legacy/`, `vendor/`, `docs/`, live scripts, or scanner scripts; live doctor verified `https://www.zhipin.com/web/chat/recommend` and used no `Runtime.*`.

## Phase 10: Final End-To-End Live Validation

Final phase.

Status: mandatory 20+ candidate completion gate passed on 2026-05-02 11:59 Asia/Shanghai. `npm run gate:phase10-complete` returned `status=pass` using the recommend, search/recruit, and chat artifacts under `.live-artifacts\phase10-*-full-run-20-live.json`.

Live gate:

- Recommend full flow.
- Recruit full flow.
- Chat full flow.
- Mandatory 20+ candidate completion gate: recommend, recruit/search, and chat must each have at least one completed live run with `processed >= 20`, `screened >= 20`, final status `completed`, and no `Runtime.*`. Canceled, paused, failed, partial, mock-only, or one-candidate smoke runs do not satisfy final completion.
- Shared self-heal for all available domains.
- Shared lifecycle for all domains.
- Shared screening for live candidates from all domains.
- `docs/PHASE10_LIVE_VALIDATION.md` defines the required commands and artifacts.
- `npm run gate:phase10-complete` must pass before the project can be marked fully complete.

## Parallel Work Rules

Sequential:

- Phase 0 first.
- Phase 1 before browser-heavy rewrites.
- Phase 1.5 before any domain run claims robust infinite-scroll screening.
- Phase 9 after domain live verification.
- Phase 10 last.

Parallel:

- Phase 2 and Phase 3 can develop together.
- Phase 4 can develop after Phase 1 interface stability.
- Recommend, recruit, and chat rewrites can proceed in parallel after shared browser, infinite-list, lifecycle, screening, and self-heal contracts needed by that domain are live-verified.

Parallel workers may mark code `dev-ready`, but only live tests can mark `live-verified`.
