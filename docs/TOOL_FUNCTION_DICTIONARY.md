# Boss MCP 2.x Tool Function Dictionary

Last updated: 2026-05-03 Asia/Shanghai.

This dictionary describes the public tool surface, CLI commands, bundled skills, and the main exported internal functions that future agents are likely to modify. It is intentionally verbose. It should be updated whenever a tool schema, expected behavior, artifact shape, or domain process changes.

## Dictionary Reading Rules

- "Tool" means MCP tool unless explicitly marked CLI.
- "Function" means a code-level function/export.
- "Expected behavior" is normative.
- "Failure behavior" should be preserved unless a future live-verified change intentionally updates it.
- "Live gate required" means mock-only tests are insufficient for completion.

## MCP Tool Dictionary

### `list_recommend_jobs`

Purpose:

- Read all available job names from the Boss recommend page job dropdown.
- Support cron/one-shot setup where users need exact job strings before starting a run.
- This tool is read-only and must not start screening.

Inputs:

- `host`: optional Chrome debug host, default `127.0.0.1`.
- `port`: optional Chrome debug port, default `9222`.
- `target_url_includes`: optional Chrome target URL matcher, default recommend page.
- `allow_navigate`: optional boolean. If true, the tool may navigate to the recommend page when the current target is not there.
- `slow_live`: optional boolean. Enables longer waits for VPN/slow pages.

Expected behavior:

- Connect to Chrome through `connectToChromeTargetOrOpen`.
- If local Chrome DevTools `127.0.0.1:9222` is unavailable and navigation is allowed, auto-launch Chrome with the recommend URL before reading the dropdown.
- Enable `Page`, `DOM`, and `Input`.
- Bring the recommend page to front.
- Locate `iframe[name="recommendFrame"]` through DOM `describeNode(...contentDocument)`.
- Open the job dropdown by calculating the trigger center from `DOM.getBoxModel` and clicking with `Input.dispatchMouseEvent`.
- Read all option labels and current selection state.
- Close dropdown before returning.
- Return `job_options` and `job_names`.
- Include CDP method log/summary where applicable.
- Fail if any `Runtime.*` method is called.

Failure behavior:

- Return `FAILED` with `BOSS_LOGIN_REQUIRED` and `requires_login=true` when Chrome is available/opened but Boss needs human login.
- Return `FAILED` with a retryable browser/page readiness error when Chrome executable, page roots, or account capability are unavailable.
- Do not fall back to search/recruit or legacy tools.

Live gate required:

- Yes, after changing recommend job dropdown selectors or root handling.

### `prepare_recommend_pipeline_run`

Purpose:

- Validate that a recommend-page payload is complete enough for immediate run or cron/one-shot scheduling without starting screening.

Inputs:

- Same input schema as `start_recommend_pipeline_run`.

Expected behavior:

- Return `NEED_INPUT`, `NEED_CONFIRMATION`, or `FAILED` with the same parser/config gates as start.
- Return `READY` with `cron_ready=true` only when all values, exact job, explicit `human_behavior.restLevel`, final review, and config gates are satisfied.
- Do not connect to Chrome for screening and do not create a `run_id`.
- Intended immediate-run flow: after `READY + cron_ready=true`, call MCP `run_recommend` or `start_recommend_pipeline_run` with the same payload. Do not switch to shell/CLI fallback when MCP tools are available.
- Intended cron setup flow: call `list_recommend_jobs` first to auto-open/reuse Chrome and verify login/page/job options, then call this prepare tool, then schedule the same ready payload with `schedule_recommend_pipeline_run`.

Live gate required:

- No, unless readiness gates or public schema semantics change.

### `schedule_recommend_pipeline_run`

Purpose:

- Create a package-owned delayed recommend run after the payload is cron-ready.
- Avoid external AI harnesses reconstructing shell cron commands and losing confirmation JSON/file arguments.

Inputs:

- Same input schema as `start_recommend_pipeline_run`.
- One scheduling field is required: `schedule_run_at`, `schedule_delay_minutes`, or `schedule_delay_seconds`.
- Optional `schedule_id`.

Expected behavior:

- Internally run the same prepare gate first.
- If prepare is not `READY + cron_ready=true`, return the prepare gate payload with `schedule_created=false`.
- Persist the exact stripped run payload under `~/.boss-recommend-mcp/schedules/<schedule_id>.json`.
- Launch a detached scheduler worker immediately and return `SCHEDULED` with `schedule_id`, `run_at`, worker log paths, and the saved schedule.
- At due time, the worker calls `start_recommend_pipeline_run` directly in package code and keeps polling until the inner run is terminal.

Live gate required:

- Mock tests are enough for schema/payload persistence. A live delayed run is recommended after changing worker launch or poll behavior.

### `get_recommend_scheduled_run`

Purpose:

- Inspect a package-owned scheduled recommend run.

Inputs:

- `schedule_id`: required.

Expected behavior:

- Return the saved schedule state, including worker state, `run_id` once launched, and the current/terminal run snapshot.
- Mark non-terminal schedules failed if the scheduler worker pid has exited.

Live gate required:

- No for status-shape changes; yes if liveness semantics change.

### `run_recommend`

Purpose:

- Short MCP alias for `start_recommend_pipeline_run`.
- Give Trae/Trae-CN and other agents an obvious `run` tool to call after `prepare_recommend_pipeline_run` returns `READY`.

Inputs:

- Same input schema as `start_recommend_pipeline_run`.

Expected behavior:

- Route through the same implementation as `start_recommend_pipeline_run`.
- Return `NEED_INPUT`, `NEED_CONFIRMATION`, `FAILED`, or `ACCEPTED` with the same payload shapes.
- When the MCP runtime needs detachment, use the package-owned detached worker inside the MCP call. Do not ask agents to reconstruct the run through CLI unless they have no MCP tool access at all.

Live gate required:

- No, because this is an alias over the existing start tool.

### `start_recommend_pipeline_run`

Purpose:

- Asynchronously start a recommend-page screening run after parser, confirmation, page readiness, job selection, and final-review gates. `run_recommend` is an MCP alias for this tool.

Inputs:

- `instruction`: required natural-language user request.
- `confirmation`: optional object with explicit user confirmations.
- `overrides`: optional object for normalized values.
- `follow_up`: currently legacy-only; do not use for new recommend-to-chat chaining.
- `detail_limit`: optional advanced cap for opened candidate details/CVs. Default follows `target_count`/`max_candidates`.
- `allow_card_only_screening`: optional debug escape hatch. Only when this is `true` will `detail_limit: 0` be honored.

Important confirmation fields:

- New recommended shape: put normalized values in `overrides`, put explicit rest level in `human_behavior.restLevel`, and set only `confirmation.final_confirmed=true` after the user confirms the consolidated review.
- Legacy shape remains compatible: `page_confirmed`, `school_tag_confirmed`, `degree_confirmed`, `gender_confirmed`, `recent_not_view_confirmed`, `criteria_confirmed`, `target_count_confirmed`, `post_action_confirmed`, `max_greet_count_confirmed`, and `job_confirmed`.

Expected behavior:

- Reject missing `instruction`.
- Parse request with `parseRecommendInstruction`.
- Return value-specific `NEED_INPUT` / `NEED_CONFIRMATION` only for missing or invalid values such as criteria, job, post action, max greet count when greeting, invalid school tags, or missing/invalid rest level.
- If all values are present but `final_confirmed` is not true, return one `NEED_CONFIRMATION` with a single `final_review` question.
- Connect to Chrome only after enough preflight state is available.
- If the default local debug port is closed, automatically open Chrome and navigate to the recommend page.
- If Boss login is detected by URL or DOM-only login panel probes, stop before any run mutation and return `BOSS_LOGIN_REQUIRED`.
- Read job options and require an exact job value before starting.
- Require `human_behavior.restLevel` and `final_confirmed=true` before starting.
- Start the shared recommend run service.
- Return `ACCEPTED` with `run_id`, artifact paths, normalized input, and poll guidance.

Run behavior after accepted:

- Select job and page scope.
- Apply filters.
- Process candidates from infinite list.
- Open candidate detail/CV by default for real screening.
- Ignore accidental `detail_limit: 0` in production screening unless `allow_card_only_screening=true`.
- Acquire CV via network primary and image fallback.
- Screen candidate.
- Execute configured post action for passed candidates.
- Refresh at list end if target not met and refresh rounds remain.
- Persist checkpoint, report JSON, and legacy-compatible CSV.

Failure behavior:

- `NEED_CONFIRMATION` for unconfirmed values.
- `FAILED` for preflight, Chrome, login, page root, or run creation errors.
- `BOSS_LOGIN_REQUIRED` is retryable after the user logs in inside the opened Chrome window; callers should retry with the same parameters.
- Never fall back to recruit/search on recommend page errors.

Live gate required:

- Yes for any change to browser interaction, filters, page scopes, detail extraction, CV acquisition, actions, refresh, CSV output, or lifecycle.

### `get_recommend_pipeline_run`

Purpose:

- Read a recommend run state snapshot by `run_id`.

Inputs:

- `run_id`: required.

Expected behavior:

- Validate safe run ID string.
- Return current status, phase, progress, checkpoint, artifacts, summary if available, output CSV path, report JSON path, and timing.
- Safe to call repeatedly.
- Does not advance browser state.

Failure behavior:

- Return `FAILED` if `run_id` is missing or unknown.

Live gate required:

- No for pure formatting changes; yes if state persistence semantics change.

### `pause_recommend_pipeline_run`

Purpose:

- Cooperatively pause a running recommend run.

Inputs:

- `run_id`: required.

Expected behavior:

- Mark pause requested.
- Active workflow stops after the current safe checkpoint/current candidate, not mid-click.
- Status becomes `paused`.
- Existing checkpoint and CSV path remain stable.

Failure behavior:

- Return `FAILED` if run is missing or terminal.

Live gate required:

- Yes if lifecycle mechanics change.

### `resume_recommend_pipeline_run`

Purpose:

- Resume a paused recommend run with the same run ID and artifacts.

Inputs:

- `run_id`: required.

Expected behavior:

- Continue from existing in-memory run service state when available.
- Preserve same CSV/checkpoint/report paths.
- Continue processing without restarting from scratch.

Failure behavior:

- Return `FAILED` if run is missing, terminal, or not resumable.

Live gate required:

- Yes if lifecycle mechanics change.

### `cancel_recommend_pipeline_run`

Purpose:

- Cancel a running or queued recommend run.

Inputs:

- `run_id`: required.

Expected behavior:

- Set canceling/canceled state.
- Workflow should stop before further candidate actions.
- Artifact state should record canceled status.

Failure behavior:

- Return `FAILED` if run is missing or already terminal.

Live gate required:

- Yes if cancellation behavior around post actions changes.

### `run_recommend_self_heal`

Purpose:

- Manual maintenance tool for recommend page health probes and drift reporting.

Inputs:

- `mode`: `scan` or `apply`.
- `scope`: `full`, `search_screen`, or `selectors_only`.
- `validation_profile`: `safe` or `full`.
- `port`: optional.
- `repair_session_id`: required for apply mode.
- `confirm_apply`: must be true for apply mode.

Expected behavior:

- In scan mode, connect to recommend page, resolve roots, run selector/accessibility/network probes, summarize health, and build drift report.
- In apply mode, fail closed unless a live-verified repair path exists and `confirm_apply` is true.
- Never run automatically as part of normal screening.

Failure behavior:

- Missing page/account capability is an environment blocker, not a pass.
- Apply without explicit confirmation fails.

Live gate required:

- Yes for any probe, repair, or selector fallback change.

### `get_featured_calibration_status`

Purpose:

- Report featured favorite calibration file/script status.

Inputs:

- None.

Expected behavior:

- Return current calibration file path, whether it exists, whether it is usable, and whether legacy calibration script was found.
- This is informational.

Failure behavior:

- Should not mutate files or page state.

Live gate required:

- No unless featured scope calibration behavior is re-enabled.

### `run_featured_calibration`

Purpose:

- Legacy-visible tool name for featured favorite calibration.

Current status:

- Intentionally unsupported/fenced in CDP-only 2.x.

Expected behavior:

- Return `FAILED` with `FEATURED_CALIBRATION_UNSUPPORTED_CDP_ONLY`.
- Do not call legacy calibration scripts.

Live gate required:

- Yes before any future re-enable.

### `run_recruit_pipeline`

Purpose:

- Compatibility search/recruit entrypoint. Defaults to async; sync mode waits for terminal state.

Inputs:

- `instruction`: natural language user request.
- `confirmation`: optional confirmations.
- `overrides`: optional normalized search/screen values.
- `mode`: optional `async` or `sync`.
- Search fields may include `job`, `keyword`, `city`, `degree`, `school_tag`, `recent_not_view`.
- Screen fields may include `criteria`, `target_count`, `post_action`, `max_greet_count`.

Expected behavior:

- Validate arguments with `validateRecruitPipelineArgs`.
- Parse with `parseRecruitInstruction`.
- Return confirmation/missing-input prompts if needed.
- Start or run the recruit/search workflow through shared CDP-only service.
- Write legacy-compatible CSV and JSON report.

Failure behavior:

- Missing job should trigger prompt/need-input; do not guess default job.
- Browser/page/search failures return `FAILED`.

Live gate required:

- Yes for search controls, city/degree/school filters, detail, CV, post action, refresh, CSV, or lifecycle changes.

### `start_recruit_pipeline_run`

Purpose:

- Asynchronously start a search/recruit run.

Inputs:

- Same normalized/confirmation shape as `run_recruit_pipeline`.

Expected behavior:

- Return `ACCEPTED` with `run_id` after confirmation and preflight gates.
- If local Chrome DevTools `127.0.0.1:9222` is unavailable, auto-launch Chrome and navigate to `https://www.zhipin.com/web/chat/search`.
- If Boss login is detected, return `BOSS_LOGIN_REQUIRED` before starting the run.
- Run in the shared recruit run service.

Failure behavior:

- Same as `run_recruit_pipeline`.

Live gate required:

- Yes for workflow changes.

### `get_recruit_pipeline_run`

Purpose:

- Read search/recruit run status by `run_id`.

Expected behavior:

- Return current status, progress, checkpoint, artifacts, CSV path, report path, and summary when available.

Failure behavior:

- Return `FAILED` for unknown/missing run.

### `pause_recruit_pipeline_run`

Purpose:

- Cooperatively pause a running search/recruit run.

Expected behavior:

- Pause at safe checkpoint after current candidate.

### `resume_recruit_pipeline_run`

Purpose:

- Resume a paused search/recruit run.

Expected behavior:

- Continue with same run ID and artifacts.

### `cancel_recruit_pipeline_run`

Purpose:

- Cancel a running search/recruit run.

Expected behavior:

- Stop further candidate action and record canceled state.

### `boss_chat_health_check`

Purpose:

- Check chat page readiness, runtime directories, config, and chat self-heal probes.

Inputs:

- `host`: optional.
- `port`: optional.
- `target_url_includes`: optional.
- `allow_navigate`: optional.
- `slow_live`: optional.

Expected behavior:

- Resolve `screening-config.json`.
- Resolve chat runtime data dir.
- Connect to Chrome through the shared auto-open browser layer.
- If local Chrome DevTools `127.0.0.1:9222` is unavailable, auto-launch Chrome and navigate to `https://www.zhipin.com/web/chat/index`.
- Navigate to chat target if allowed.
- Run CDP-only health probes.
- Return readiness information and diagnostics.

Failure behavior:

- Missing config, Chrome, login, or page roots return failed health with recovery guidance.

Live gate required:

- Yes for page readiness/probe changes.

### `prepare_boss_chat_run`

Purpose:

- Prepare a chat run without starting it.

Inputs:

- Optional partial chat fields: `job`, `start_from`, `target_count`, `criteria`, `profile`, `port`, `slow_live`.

Expected behavior:

- Connect to chat page.
- Auto-launch/navigate local Chrome when the debug port is missing.
- Return `BOSS_LOGIN_REQUIRED` if Boss login is detected by URL or DOM-only login panel probes.
- Read job options.
- Return `job_options`, `pending_questions`, and missing required fields.
- Do not start a run.
- Do not process candidates.

Failure behavior:

- Return `FAILED` if page/config/browser unavailable.

Live gate required:

- Yes for job-list or page-root changes.

### `start_boss_chat_run`

Purpose:

- Start chat screening/CV-request workflow.

Required inputs:

- `job`
- `start_from`: `unread` or `all`
- `target_count`: positive integer or all-token.
- `criteria`

Optional inputs:

- `profile`
- `greeting_text` or `greetingText`
- `port`
- `dry_run`
- `no_state`
- `safe_pacing`
- `batch_rest_enabled`
- `detail_limit`
- `delay_ms`
- `max_candidates`

Expected behavior:

- Require all required inputs at start.
- Auto-launch/navigate local Chrome when the debug port is missing.
- Return `BOSS_LOGIN_REQUIRED` before run creation if Boss login is required.
- Normalize all/unlimited target tokens to all-mode.
- Start async chat run service and return `ACCEPTED` with `run_id`.
- For passed candidates, request CV unless already available/requested.
- For `target_count=all`, process until list end and complete even if no candidate passes.

Failure behavior:

- Return `NEED_INPUT` with `missing_fields` and `next_call_example` if required fields are missing.
- Return `FAILED` on browser/config/page errors.

Live gate required:

- Yes for any chat interaction, CV request, target_count, or resume extraction change.

### `get_boss_chat_run`

Purpose:

- Read chat run status by `run_id`.

Inputs:

- `run_id`: required.
- `profile`: optional.

Expected behavior:

- Return status, progress, checkpoint, output CSV path, report JSON path, and summary.

### `pause_boss_chat_run`

Purpose:

- Pause chat workflow after a safe checkpoint.

Expected behavior:

- Do not leave browser mid-action when avoidable.
- Resume should use same run ID.

### `resume_boss_chat_run`

Purpose:

- Resume paused chat workflow.

Expected behavior:

- Continue from existing state and preserve artifacts.

### `cancel_boss_chat_run`

Purpose:

- Cancel a running chat workflow.

Expected behavior:

- Stop before further candidate/CV request actions and persist canceled status.

## CLI Command Dictionary

### `boss-recommend-mcp` / `boss-recommend-mcp start`

Starts the MCP server using stdio JSON-RPC. Supports both header and line framing as implemented in `src/index.js`.

Expected behavior:

- Read workspace root from `BOSS_WORKSPACE_ROOT`, `INIT_CWD`, or `process.cwd()`.
- Serve `initialize`, `tools/list`, `tools/call`, and `ping`.

### `boss-recommend-mcp install`

Installs or migrates local runtime assets.

Expected behavior:

- Ensure runtime directories.
- Install bundled Codex skills.
- Initialize or patch `screening-config.json`.
- Export MCP config templates.
- Auto-configure detected external MCP config files.
- Migrate legacy Boss MCP entries to unified package route.
- Mirror all bundled skills to detected external skill dirs.
- Print all changed files and backups.

Important options:

- `--agent trae-cn`
- `--agent openclaw`
- `--workspace-root <path>`

Environment overrides:

- `BOSS_RECOMMEND_MCP_CONFIG_TARGETS`
- `BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS`
- `CODEX_HOME`
- `BOSS_RECOMMEND_HOME`

### `boss-recommend-mcp install-skill`

Installs bundled skills into `CODEX_HOME/skills`.

Bundled skills:

- `boss-recommend-pipeline`
- `boss-recruit-pipeline`
- `boss-chat`

### `boss-recommend-mcp init-config`

Creates `screening-config.json` if missing and ensures runtime directories.

Expected behavior:

- Prefer workspace config path if safe/writable.
- Otherwise write to `~/.boss-recommend-mcp/screening-config.json`.
- Patch missing install defaults on existing config.

### `boss-recommend-mcp config set` / `set-config`

Writes LLM configuration fields.

Common fields:

- `--base-url`
- `--api-key`
- `--model`
- `--thinking-level`
- `--openai-organization`
- `--openai-project`

### `boss-recommend-mcp set-port`

Persists preferred Chrome debug port to config.

Priority order at runtime:

1. Explicit `--port`.
2. `BOSS_RECOMMEND_CHROME_PORT`.
3. `screening-config.json.debugPort`.
4. `9222`.

### `boss-recommend-mcp mcp-config`

Generates MCP config templates.

Supported client values:

- `generic`
- `cursor`
- `trae`
- `claudecode`
- `openclaw`
- `all`

### `boss-recommend-mcp doctor`

Checks local runtime, config, Chrome debug port, calibration file state, page readiness, and optional external agent integration.

Important options:

- `--agent trae-cn`
- `--agent openclaw`
- `--page-scope recommend|featured|latest`
- `--slow-live`
- `--port 9222`

Expected behavior:

- Return JSON report.
- Treat featured calibration as required only for featured scope.
- Check external route guards when `--agent` is provided.

### `boss-recommend-mcp list-jobs`

CLI wrapper for `list_recommend_jobs`.

Aliases:

- `jobs`
- `recommend-jobs`

Expected behavior:

- Print JSON payload.
- Support `--slow-live`, `--port`, `--host`, `--target-url-includes`, `--no-navigate`.

### `boss-recommend-mcp prepare-run`

CLI wrapper for `prepare_recommend_pipeline_run`.

Aliases:

- `prepare`

Expected behavior:

- Print JSON payload.
- Return `READY` plus `cron_ready=true` only for a schedulable payload.
- Exit successfully only when the payload is cron-ready; exit non-zero for `NEED_INPUT`, `NEED_CONFIRMATION`, or `FAILED`.
- Support `--instruction`, `--instruction-file`, `--confirmation-json`, `--confirmation-file`, `--overrides-json`, `--overrides-file`, `--slow-live`, `--port`, `--host`, `--target-url-includes`, `--no-navigate`, and `--rest-level`.
- For the simplified flow, `--confirmation-file` can contain only `{ "final_confirmed": true }` once the user has confirmed the consolidated review.

### `boss-recommend-mcp schedule-run`

CLI wrapper for `schedule_recommend_pipeline_run`.

Aliases:

- `schedule`

Expected behavior:

- Print JSON payload.
- Return `SCHEDULED` only after a package-owned detached scheduler worker is launched.
- Support the same run payload inputs as `prepare-run`, plus `--schedule-delay-minutes`, `--schedule-delay-seconds`, `--schedule-run-at`, and optional `--schedule-id`.

### `boss-recommend-mcp schedule-status`

CLI wrapper for `get_recommend_scheduled_run`.

Aliases:

- `scheduled-run`

Expected behavior:

- Print JSON schedule state for `--schedule-id`.

### `boss-recommend-mcp run`

Current status:

- CDP-only CLI wrapper for `start_recommend_pipeline_run`.

Expected behavior:

- Return the same gate statuses as MCP (`NEED_INPUT`, `NEED_CONFIRMATION`, `ACCEPTED`, or `FAILED`) as JSON.
- Support `--instruction`, `--instruction-file`, `--confirmation-json`, `--confirmation-file`, `--overrides-json`, and `--overrides-file`.
- Support `--detached` for shell-only agents such as QClaw: the parent process prints the first JSON start/gate result, while the detached child keeps the CDP session and run lifecycle alive after `ACCEPTED`.

### `boss-recommend-mcp chat health-check`

CLI wrapper for `boss_chat_health_check`.

Expected behavior:

- Print JSON health report.

### `boss-recommend-mcp chat prepare-run`

CLI wrapper for `prepare_boss_chat_run`.

Expected behavior:

- Print job options and missing fields.

### `boss-recommend-mcp chat run` / `chat start-run`

Current status:

- Intentionally fenced.

Expected behavior:

- Return `CHAT_CLI_ASYNC_UNSUPPORTED_CDP_ONLY`.
- Point users to MCP `start_boss_chat_run`.

### `boss-recommend-mcp chat get-run`

CLI wrapper for `get_boss_chat_run`.

Requires:

- `--run-id`

### `boss-recommend-mcp chat pause-run`

CLI wrapper for `pause_boss_chat_run`.

### `boss-recommend-mcp chat resume-run`

CLI wrapper for `resume_boss_chat_run`.

### `boss-recommend-mcp chat cancel-run`

CLI wrapper for `cancel_boss_chat_run`.

### `boss-recommend-mcp calibrate`

Current status:

- Intentionally fenced.

Expected behavior:

- Return `CALIBRATE_UNSUPPORTED_CDP_ONLY`.

### `boss-recommend-mcp launch-chrome`

Launches or reuses a Chrome debug instance and opens Boss recommend page.

Expected behavior:

- Reuse existing debug port if reachable.
- Otherwise find Chrome executable, launch with `--remote-debugging-port`, isolated user data dir, and recommend URL.
- Use CDP readiness checks after launch.

### `boss-recommend-mcp where`

Prints package root, skill sources, state/config/calibration paths, and default output path.

## Bundled Skill Dictionary

### `boss-recommend-pipeline`

Purpose:

- Route normal recommend-page tasks to `run_recommend` or `start_recommend_pipeline_run`; route delayed/cron setup through `list_recommend_jobs` plus `prepare_recommend_pipeline_run` plus `schedule_recommend_pipeline_run`.

Expected behavior:

- Gather missing values, read exact job options, then show one consolidated final review.
- After the user confirms, submit normalized values in `overrides`, explicit `human_behavior.restLevel`, and `confirmation.final_confirmed=true`; do not manufacture the old per-field booleans unless preserving an existing legacy payload.
- For cron setup, create no timer unless `prepare_recommend_pipeline_run` returns `READY` and `cron_ready=true`, then `schedule_recommend_pipeline_run` returns `SCHEDULED`.
- Preserve the exact instruction/criteria payload that was prepared when passing it into the package-owned scheduler.
- Do not hand-write shell cron or natural-language future reminders for recommend runs.
- Do not ask for job before page readiness/job options are available.
- Do not route recommend failures to recruit.
- Do not use `follow_up.chat`; recommend-to-chat auto-chain is legacy-only.

### `boss-recruit-pipeline`

Purpose:

- Route search/recruit-page tasks to unified `run_recruit_pipeline` / `start_recruit_pipeline_run`.
- Replace legacy `boss-recruit-mcp` skill installs.

Expected behavior:

- Ask for missing job.
- Use search/recruit tools only when user clearly asks for search/recruit page.
- Never call old `@reconcrap/boss-recruit-mcp`.

### `boss-chat`

Purpose:

- Route chat-only tasks to bundled chat MCP tools.

Expected behavior:

- Use `prepare_boss_chat_run` first to get job options.
- Start only with job/start_from/target_count/criteria.
- Treat all/全部/扫到底 as `target_count: "all"`.
- Do not auto-poll unless user asks.

## Internal Function And Module Dictionary

### `src/core/browser/index.js`

This is the only acceptable low-level browser access layer.

Important exports:

- `ALLOWED_CDP_DOMAINS`: documents permitted CDP domains.
- `FORBIDDEN_CDP_DOMAINS`: currently contains `Runtime`.
- `BOSS_LOGIN_URL`: canonical Boss login URL shown to users when login is required.
- `assertNoForbiddenCdpCalls(methodLog)`: throws if method log contains forbidden calls.
- `isBossLoginUrl(url)`: detects Boss login URLs.
- `detectBossLoginState(client, { currentUrl })`: detects login by URL first, then by CDP DOM selectors/outer HTML without page JS.
- `createBossLoginRequiredError({ domain, currentUrl, targetUrl, loginDetection })`: creates the structured retryable login error used by recommend/search/chat tools.
- `isChromeDebugUnavailableError(error)`: detects closed/unreachable local DevTools ports.
- `getChromeExecutable()`: resolves Chrome path from env vars and platform defaults.
- `getBossChromeUserDataDir(port)`: returns the isolated Boss MCP Chrome profile path.
- `waitForChromeDebugPort({ host, port })`: polls DevTools target listing until Chrome is reachable.
- `launchChromeDebugInstance({ host, port, url })`: launches local Chrome with `--remote-debugging-port`, isolated user data dir, and starting URL.
- `ensureChromeDebugPort({ host, port, url, launchIfMissing })`: reuses an existing debug port or launches Chrome if local and allowed.
- `openChromeTarget({ host, port, url })`: opens a new DevTools target using `/json/new`.
- `createGuardedCdpClient(client, { methodLog })`: wraps raw CDP client and records/blocks methods.
- `listChromeTargets({ host, port })`: reads Chrome targets.
- `connectToChromeTarget({ host, port, targetUrlIncludes, targetPredicate })`: connects to a matching target and returns guarded client/session data.
- `connectToChromeTargetOrOpen({ host, port, targetUrlIncludes, targetUrl, allowNavigate })`: shared run-start connector that auto-launches local Chrome when needed, opens/navigates the requested Boss target, then returns a guarded session.
- `assertRuntimeEvaluateBlocked(client)`: live proof helper that `Runtime.evaluate` is blocked.
- `enableDomains(client, domains)`: enables allowed CDP domains.
- `bringPageToFront(client)`: calls `Page.bringToFront`.
- `getPageFrameTree`, `getMainFrame`, `getMainFrameUrl`, `waitForMainFrameUrl`: frame/page URL helpers.
- `getDocumentRoot`: calls `DOM.getDocument`.
- `querySelector`, `querySelectorAll`, `findFirstNode`: selector helpers.
- `describeNode`, `getFrameDocumentNodeId`, `findIframeDocument`: iframe/root helpers.
- `getAttributesMap`, `getOuterHTML`: node data readers.
- `getNodeBox`: returns border/content/quads and center point from `DOM.getBoxModel`.
- `clickPoint`, `scrollNodeIntoView`, `clickNodeCenter`: CDP Input/DOM interaction helpers.
- `pressKey`, `insertText`, `selectAllFocusedText`, `clearFocusedInput`: keyboard/text helpers.
- `waitForSelector`, `countSelectors`: polling/count helpers.
- `getAccessibilityTree`: AX tree reader.
- `sleep`: timing helper.

Expected behavior:

- No helper here may call `Runtime.*`.
- Any new browser primitive must record its CDP method calls through the guarded client.
- Auto-launch is local-host only; never spawn Chrome for remote debug hosts.
- Missing Chrome debug port is recoverable through auto-launch. Missing Boss login is recoverable only after human login.

### `src/core/capture/index.js`

Purpose:

- Capture DOM HTML and screenshots without page JS.

Important exports:

- `captureNodeHtml`: saves outer HTML for a node.
- `captureNodeScreenshot`: screenshots a node area by box model/clip.
- `captureViewportScreenshot`: screenshots current viewport.
- `captureScrolledNodeScreenshots`: scrolls a node/viewport and captures a sequence until max pages/stability.
- `captureCandidateEvidence`: combines HTML/screenshot capture for candidate evidence.

Expected behavior:

- Full-scroll capture must not collapse to single viewport when used for CV fallback.
- Screenshots should have deterministic output metadata and paths.

### `src/core/cv-acquisition/index.js`

Purpose:

- Track whether a run is currently seeing network CVs or image-only CVs and adapt wait times.

Important exports:

- `createCvAcquisitionState`: creates mode/attempt counters.
- `getCvNetworkWaitPlan`: chooses wait/retry/grace duration based on prior hits/misses.
- `waitForCvNetworkEvents`: waits on a domain recorder and returns parsed events.
- `countParsedNetworkProfiles`, `hasParsedNetworkProfile`: summarize network usefulness.
- `summarizeImageEvidence`: compact image fallback metadata.
- `recordCvNetworkHit`: mark successful network CV.
- `recordCvNetworkMiss`: mark network miss.
- `recordCvImageFallback`: mark image fallback.
- `compactCvAcquisitionState`: return small serializable state.

Expected behavior:

- Always attempt network first.
- Shorten network wait after evidence suggests image mode.
- Preserve enough state in run summary for debugging.

### `src/core/greet-quota/index.js`

Purpose:

- Parse and enforce greet credit labels.

Important exports:

- `GREET_CREDITS_EXHAUSTED_CODE`: error code.
- `parseGreetQuota(label)`: parses labels such as `30/135`.
- `normalizeGreetQuotaSource(source)`: normalizes quota text.
- `assertGreetQuotaAvailable(source)`: throws if numerator is greater than denominator or credits are exhausted.

Expected behavior:

- If a greet button shows impossible/exhausted quota such as `30/20`, do not click greet and stop the run.

### `src/core/infinite-list/index.js`

Purpose:

- Process virtualized/infinite candidate lists without missing or duplicating candidates.

Important exports:

- `candidateKeyFromProfile`: creates stable candidate key.
- `createInfiniteListState`: initializes seen/processed/signature state.
- `compactInfiniteListState`: serializes state.
- `markInfiniteListCandidateProcessed`: records processed key.
- `markInfiniteListCandidateSkipped`: records skipped key.
- `resetInfiniteListForRefreshRound`: resets scroll-specific state while preserving high-level refresh metadata.
- `readVisibleInfiniteListItems`: reads visible candidates via provided domain callbacks.
- `updateInfiniteListVisibleSignature`: tracks stable visible signature.
- `firstUnseenInfiniteListItem`: picks next unseen candidate.
- `scrollInfiniteListByVisibleItems`: scrolls by visible item box or fallback point.
- `getNextInfiniteListCandidate`: high-level loop that reads, dedupes, scrolls, and detects end.

Expected behavior:

- Never rely only on visible index.
- Keep processed candidates across scrolls.
- End detection should require stability, not one failed scroll.

### `src/core/reporting/legacy-csv.js`

Purpose:

- Produce CSV compatible with the legacy tool shape.

Important exports:

- `LEGACY_INPUT_HEADER`, `LEGACY_RESULT_HEADER`: output headers.
- `buildLegacyScreenInputRows`: builds input-condition rows.
- `defaultLegacyCsvPathForReport`: derives CSV path from report path.
- `legacyScreenResultRow`: maps a candidate result to CSV row.
- `writeLegacyScreenCsv`: writes input section and result section.
- `cloneReportInput`: safe clone helper.

Expected behavior:

- CSV must include all user input criteria/filters.
- CSV must include full LLM CoT/reasoning/raw output where available.
- CSV should not require user-facing LLM reasons.

### `src/core/run/index.js`

Purpose:

- In-memory lifecycle manager for domain workflows.

Important exports:

- Run status constants: `queued`, `running`, `paused`, `completed`, `canceling`, `canceled`, `failed`.
- `RunCanceledError`: cancellation exception.
- `createRunLifecycleManager`: creates async lifecycle with start/get/pause/resume/cancel, progress, phase, checkpoint.

Expected behavior:

- Pause is cooperative.
- Cancel stops future actions.
- Snapshots must be serializable.

### `src/core/screening/index.js`

Purpose:

- Normalize candidate profiles and call LLM screening.

Important exports:

- `normalizeText`, `decodeHtmlEntities`, `htmlToText`, `parseHtmlAttributes`: text/HTML helpers.
- `buildScreeningLlmImageInputs`: converts screenshot paths to LLM image inputs.
- `extractBossProfileFromNetworkBody`: parses Boss network responses into profile candidates.
- `mergeCandidateProfiles`: merges card/detail/network/image-derived profile data.
- `buildScreeningCandidateFromDetail`: builds screening input from domain detail extraction.
- `normalizeCandidateProfile`: normalizes raw profile fields.
- `normalizeCandidateFromHtml`: fallback HTML profile parser.
- `screenCandidate`: local/basic screening helper.
- `buildScreeningLlmMessages`: creates compact pass/fail LLM prompt/messages.
- `callScreeningLlm`: calls configured LLM and parses pass/fail output.

Expected behavior:

- LLM prompt should ask for pass/fail only and capture CoT internally.
- Image evidence should be supported for fallback CV screening.
- Candidate identity should remain attached to screening output.

### `src/core/self-heal/index.js`

Purpose:

- Shared selector/accessibility/network health probes plus viewport-collapse detection/recovery.

Important exports:

- Probe/health constants.
- `createSelectorProbe`, `createAccessibilityProbe`, `createNetworkProbe`, `createViewportCollapseProbe`.
- `runSelectorProbe`, `runAccessibilityProbe`, `runNetworkProbe`, `runViewportCollapseProbe`.
- `summarizeProbeResults`, `buildDriftReport`, `runSelfHealCheck`.
- `buildRecommendSelfHealConfig`, `buildRecruitSelfHealConfig`, `buildChatSelfHealConfig`.
- `resolveRecommendSelfHealRoots`, `resolveRecruitSelfHealRoots`, `resolveChatSelfHealRoots`.
- `buildViewportHealthDiagnostics`, `isListViewportCollapsed`, `ensureHealthyViewport`, `createViewportRunGuard`.

Expected behavior:

- Selector/accessibility/network probes are diagnostic unless an explicit, live-verified apply path exists.
- Viewport-collapse probes may repair Chrome window state because this is a CDP-only browser-window recovery, not page-state mutation.
- Recommend, search/recruit, and chat runs automatically call `createViewportRunGuard`; recoveries and failures are recorded in run checkpoints and summaries.
- Failed probes should be actionable and domain-specific.

### `src/recommend-mcp.js`

Purpose:

- MCP-facing recommend orchestration and artifact persistence.

Important exports:

- `listRecommendJobsTool`
- `startRecommendPipelineRunTool`
- `getRecommendPipelineRunTool`
- `pauseRecommendPipelineRunTool`
- `resumeRecommendPipelineRunTool`
- `cancelRecommendPipelineRunTool`
- `getRecommendMcpHealthSnapshot`

Expected behavior:

- Wrap domain service with MCP status shapes.
- Persist checkpoint/CSV/report artifacts.
- Convert domain progress into legacy-compatible progress fields.

### `src/recruit-mcp.js`

Purpose:

- MCP-facing search/recruit orchestration and artifacts.

Important exports:

- `createRecruitPipelineInputSchema`
- `createRecruitRunIdInputSchema`
- `validateRecruitPipelineArgs`
- `runRecruitPipelineTool`
- `startRecruitPipelineRunTool`
- `getRecruitPipelineRunTool`
- `pauseRecruitPipelineRunTool`
- `resumeRecruitPipelineRunTool`
- `cancelRecruitPipelineRunTool`

Expected behavior:

- Preserve legacy recruit MCP tool names while routing to new shared CDP-only service.
- Persist artifacts under recruit state home.

### `src/chat-mcp.js`

Purpose:

- MCP-facing chat health, prepare, start, status, pause/resume/cancel.

Important exports:

- `prepareBossChatRunTool`
- `bossChatHealthCheckTool`
- `startBossChatRunTool`
- `getBossChatRunTool`
- `pauseBossChatRunTool`
- `resumeBossChatRunTool`
- `cancelBossChatRunTool`

Expected behavior:

- Require chat start fields.
- Normalize target-count all tokens.
- Persist chat artifacts under boss-chat data dir.
- Preserve request-CV action information in CSV/report.

### `src/chat-runtime-config.js`

Purpose:

- Resolve config and chat runtime paths.

Important exports:

- `TARGET_COUNT_CANONICAL_ALL`, `TARGET_COUNT_ACCEPTED_EXAMPLES`.
- `resolveBossChatDataDir`, `getBossChatDataDir`.
- `getLegacyBossChatWorkspaceDataDir`.
- `resolveBossChatRuntimeLayout`.
- `getBossScreenConfigResolution`.
- `getFeaturedCalibrationResolution`.
- `resolveBossScreeningConfig`.
- `getBossChatTargetCountValue`.
- `buildTargetCountCompatibilityHints`.
- `normalizeTargetCountInput`.

Expected behavior:

- Prefer safe user state dirs over npm temp or system dirs.
- Support legacy config paths for migration/read compatibility.
- Normalize all/全部/扫到底 values consistently.

### `src/index.js`

Purpose:

- MCP server.

Important exports:

- `startServer`

Expected behavior:

- JSON-RPC stdio server.
- Expose all tool schemas.
- Validate inputs before handler dispatch.
- Return `structuredContent` and `isError` on failed payloads.

### `src/cli.js`

Purpose:

- CLI, installer, doctor, and local operator helpers.

Important exports:

- `runCli`

Expected behavior:

- Auto-sync bundled skills for runtime commands.
- Install/migrate external MCP and skills.
- Fence unsupported legacy one-shot routes.
- Provide doctor, where, mcp-config, config, set-port, launch-chrome, list-jobs, chat helper commands.

### `src/parser.js`

Purpose:

- Parse recommend natural-language instructions.

Important exports:

- `parseRecommendInstruction`.

Expected behavior:

- Extract filters, criteria, target count, post action, page scope, and job from user instruction, `overrides`, and legacy confirmation values.
- Return missing-value flags and pending requirements; final review is handled by the recommend MCP gate.

## Domain Module Dictionary

### Recommend domain

Files:

- `constants.js`: target URL, iframe selectors, card selectors, filter selectors, detail selectors, action selectors, network patterns.
- `roots.js`: recommend iframe/root discovery.
- `jobs.js`: job dropdown opening, option listing, option matching, job selection.
- `scopes.js`: page scope normalize/list/get/select with fallback.
- `filters.js`: filter panel open/list/select multi-groups/confirm.
- `cards.js`: candidate card discovery and card candidate extraction.
- `detail.js`: detail open/close, network recording, detail HTML/body extraction, candidate build.
- `actions.js`: favorite/greet action discovery, quota parsing integration, click/verify.
- `refresh.js`: filter selection options and refresh-at-end behavior.
- `run-service.js`: complete recommend workflow and lifecycle service factory.

Critical recommend functions:

- `getRecommendRoots`: returns main/root/recommend iframe document IDs.
- `listRecommendJobOptions`: reads dropdown options.
- `selectRecommendJob`: selects target job.
- `selectRecommendPageScope`: selects requested scope or fallback.
- `selectFilterGroups`: applies multi-select filters.
- `openRecommendCardDetail`: clicks a candidate card by DOM center.
- `extractRecommendDetailCandidate`: combines DOM/network/image detail data.
- `runRecommendWorkflow`: full domain workflow.
- `createRecommendRunService`: lifecycle wrapper.

### Recruit/search domain

Files:

- `constants.js`: target URL, iframe/card/search/detail selectors and network patterns.
- `roots.js`: search iframe/root discovery.
- `search.js`: keyword/job/city/degree/school/recent-viewed filter application and search result wait.
- `cards.js`: search card discovery and card candidate extraction.
- `detail.js`: detail open/close, network recording, content extraction.
- `actions.js`: greet/favorite controls on search detail.
- `refresh.js`: refresh at end with forced recent-viewed filtering.
- `instruction-parser.js`: search instruction parser.
- `run-service.js`: complete search workflow and lifecycle service factory.

Critical recruit/search functions:

- `normalizeRecruitSearchParams`: normalizes job/keyword/city/degrees/schools/recent-viewed.
- `setRecruitCity`: selects city, including `全国`; illegal city defaults to `全国`.
- `setRecruitDegrees`: supports multiple degrees.
- `setRecruitSchools`: supports multiple school tags.
- `setRecruitJobTitle`: selects job title next to keyword input.
- `applyRecruitSearchParams`: applies full search form.
- `refreshRecruitSearchAtEnd`: refreshes/reapplies search at list end.
- `runRecruitWorkflow`: full domain workflow.
- `createRecruitRunService`: lifecycle wrapper.

### Chat domain

Files:

- `constants.js`: target URL, chat roots, list selectors, resume selectors, action selectors.
- `page-guard.js`: forbidden top-level resume URL guard and recovery.
- `roots.js`: top/root discovery.
- `jobs.js`: chat job dropdown/list/select.
- `cards.js`: chat candidate list discovery, identity keying, find-by-id.
- `detail.js`: online resume open, network recorder, resume content wait, request-CV sequence.
- `run-service.js`: complete chat workflow and lifecycle service factory.

Critical chat functions:

- `recoverChatShell`: recovers from wrong top-level pages.
- `readChatJobOptions`: reads job options.
- `selectChatJob`: selects job.
- `selectChatMessageFilter`: selects unread/all start filter.
- `readChatCardCandidate`: extracts visible chat candidate summary.
- `selectFreshChatCandidate`: re-resolves candidate node before clicking to avoid stale node IDs.
- `openChatOnlineResume`: opens online resume through UI.
- `requestChatResumeForPassedCandidate`: checks already-requested state, sends message if needed, clicks request CV, verifies.
- `runChatWorkflow`: full chat workflow.
- `createChatRunService`: lifecycle wrapper.

## Test And Gate Dictionary

Development tests:

- `test:parser`: recommend parser behavior.
- `test:run-state`: durable run-state store.
- `test:cdp-browser`: guarded CDP browser helpers.
- `test:core-*`: shared core behavior.
- `test:recommend-*`: recommend domain/MCP/run behavior.
- `test:recruit-*`: search/recruit domain/MCP behavior.
- `test:chat-*`: chat domain/MCP/run behavior.
- `test:installer-migration`: installer migration of legacy MCP/skills.
- `test:runtime-scan`: runtime scanner, legacy boundary, package boundary, phase 9 static gate tests.

Static/package gates:

- `scan:runtime`: scans active/quarantined code for forbidden runtime/page-JS patterns.
- `scan:runtime:strict`: fails on active forbidden findings.
- `scan:runtime:package`: scans publish surface.
- `scan:runtime:package:strict`: fails on package-surface forbidden findings.
- `scan:legacy-boundary`: ensures active code/package scripts do not reference quarantined legacy paths.
- `scan:package-boundary`: runs `npm pack --dry-run --json` and fails if package includes blocked dirs/files.
- `gate:phase9-static`: aggregate static gate.
- `gate:phase10-complete`: verifies recorded Phase 10 completion criteria.

Live scripts:

- `live:cdp-smoke`
- `live:run-lifecycle`
- `live:screening`
- `live:detail`
- `live:infinite-list`
- `live:scroll-end`
- `live:refresh-round`
- `live:self-heal`
- `live:recommend-actions`
- `live:recommend-phase10-full`
- `live:recommend-domain`
- `live:recommend-run-service`
- `live:recommend-mcp`
- `live:search-phase10-full`
- `live:recruit-domain`
- `live:recruit-run-service`
- `live:recruit-mcp`
- `live:chat-domain`
- `live:chat-run-service`
- `live:chat-mcp`
- `live:chat-phase10-full`
- `live:chat-image-screening`

Live test rule:

- Passing mock tests does not mean a browser-facing module is complete.
- A live test must run against logged-in Boss Chrome and must record method logs with no `Runtime.*`.
