# Phase 10 Live Validation

Phase 10 is the final end-to-end gate. The project cannot be marked fully complete or passed until all rows in this file pass live against Boss Chrome.

Mock tests, unit tests, static gates, partial runs, paused runs, canceled runs, and one-candidate smoke tests do not satisfy this phase.

## Mandatory 20+ Candidate Runs

There must be at least one complete live run for each domain:

- Recommend: at least 20 candidates processed and screened.
- Search/recruit: at least 20 candidates processed and screened.
- Chat: at least 20 candidates processed and screened.

Each run must satisfy all of these conditions:

- Run against a logged-in Boss Chrome target through CDP only.
- Use `--slow-live` or equivalent slow timeouts when VPN/network latency is present.
- End with final status `completed`, not `canceled`, `paused`, `failed`, or timed out.
- Record `processed >= 20` and `screened >= 20` in `lifecycle.final.progress`.
- Record `unique_seen >= 20` when the run service reports `unique_seen`.
- Record exact command, timestamp, Chrome host/port, target URL, and artifact path.
- Record no `Runtime.*` CDP methods and `runtime_evaluate_used=false`.
- Use non-mutating actions unless the user explicitly approves a safe mutating action gate.

## Commands

Recommended non-mutating commands:

```powershell
npm run live:recommend-run-service -- --slow-live --no-filter --max-candidates 20 --detail-limit 0 --delay-ms 800 --pause-after-processed 0 --save-report .live-artifacts\phase10-recommend-full-run-20-live.json
```

```powershell
npm run live:recruit-run-service -- --slow-live --no-reset-search --keyword 算法工程师 --city 全国 --max-candidates 20 --detail-limit 0 --delay-ms 800 --pause-after-processed 0 --save-report .live-artifacts\phase10-search-full-run-20-live.json
```

```powershell
npm run live:chat-run-service -- --slow-live --max-candidates 20 --detail-limit 0 --delay-ms 1600 --pause-after-processed 0 --save-report .live-artifacts\phase10-chat-full-run-20-live.json
```

After all three reports exist, run:

```powershell
npm run gate:phase10-complete
```

The gate checks the default report paths above. If custom artifact paths are used, pass them explicitly:

```powershell
npm run gate:phase10-complete -- --recommend-report <path> --search-report <path> --chat-report <path>
```

## Completion Rule

`npm run gate:phase10-complete` must return `status=pass` before the project can be called fully complete.

If any page is unavailable, blocked, too slow, or logged out, record the blocker in `docs/REWRITE_STATUS.md`. Do not mark the project complete.

## Latest Live Result

2026-05-02 11:59 Asia/Shanghai: `npm run gate:phase10-complete` returned `status=pass`.

- Recommend artifact: `.live-artifacts\phase10-recommend-full-run-20-live.json`; final status `completed`; `processed=20`; `screened=20`; `unique_seen=20`; no `Runtime.*`.
- Search/recruit artifact: `.live-artifacts\phase10-search-full-run-20-live.json`; final status `completed`; `processed=20`; `screened=20`; `unique_seen=20`; no `Runtime.*`.
- Chat artifact: `.live-artifacts\phase10-chat-full-run-20-live.json`; final status `completed`; `processed=20`; `screened=20`; `unique_seen=20`; no `Runtime.*`.

Search/recruit initially failed on a VPN slow-load edge where the search page had navigated but the city controls were not mounted yet. The shared recruit search setup now waits for live controls before applying filters; the retry passed.

## Targeted Recommend Criteria Gate

2026-05-02 21:27 Asia/Shanghai: Boss recommend targeted criteria aggregate returned `status=PASS`.

- Aggregate artifact: `.live-artifacts\phase10-recommend-criteria-aggregate-pass.json`.
- CSV artifact: `.live-artifacts\phase10-recommend-criteria-results-legacy-format.csv` was re-exported from the existing clean live JSON to verify the attached legacy two-section CSV shape without additional candidate actions. Future `live:recommend-phase10-full`, recommend MCP, search/recruit MCP, and chat MCP runs now write legacy-compatible CSV artifacts; use `--save-csv <path>` to override Phase 10 script output or `--no-save-csv` to disable.
- Page/job: `https://www.zhipin.com/web/chat/recommend`, job `算法工程师 23-27届实习/校招/早期职业 _ 杭州`.
- Filters: `985`, `211`, `国内外名校`; `本科`, `硕士`, `博士`; `男`; `近14天没有`.
- LLM config: `C:\Users\yaolin\.boss-recommend-mcp\screening-config.json`.
- LLM screening output: candidate-screen prompts must request only `{"passed": true/false}`. They must not ask the LLM for reasons or evidence. CSV `评估通过详细原因` stays blank; CSV `判断依据(CoT)` records provider-returned `reasoning_content`/`cot` or raw model output when present.
- Mutating action: user-approved `greet`, capped at 5; exactly 5 live greet clicks were sent and verified by post-click `继续沟通`.
- Clean detail/LLM gate: `.live-artifacts\phase10-recommend-full-live-criteria-screening-pass.json` opened 5 details, parsed 5 Network CV profiles, screened 5 with the configured LLM, and used no `Runtime.*`.
- Image fallback gate: `.live-artifacts\phase10-recommend-full-live-image-fallback-jpeg-pass.json` forced JPEG full-CV scroll sequence, captured 5 image pages, screened with `image_input_count=5`, and used no `Runtime.*`.

Implementation notes from the live gate:

- The first mutating attempt exposed that mounted below-viewport candidate nodes must be scrolled into view before clicking; `openRecommendCardDetail` now calls CDP `DOM.scrollIntoViewIfNeeded` before `Input.dispatchMouseEvent`.
- One LLM response returned malformed JSON during continuation; the Phase 10 script now retries retryable LLM parse/transport failures once.
- PNG image evidence was too heavy for the current LLM endpoint in this live setting; forced fallback now supports JPEG quality control and passed at quality 55.

## Targeted Search Criteria Gate

2026-05-02 22:45 Asia/Shanghai correction: the 2026-05-02 22:24 Boss search targeted criteria run is invalidated for mutating greet/post-action. It remains useful evidence for filter application, detail opening, CV acquisition, and LLM screening only.

- Artifact: `.live-artifacts\phase10-search-criteria-greet-live.json`.
- CSV artifact: `.live-artifacts\phase10-search-criteria-greet-live.csv`, using the legacy two-section shape with input rows and result rows.
- Page: `https://www.zhipin.com/web/chat/search`.
- Search params: `city=杭州`, `degree=硕士`, `schools=985/211/QS100`, `keyword=算法`, `filter_recent_viewed=true`.
- Criteria: `必须有ccf-a论文或会议成果，本科学历必须至少211及以上或者海外qs200院校`.
- Command: `npm run live:search-phase10-full -- --slow-live --no-reset-search --city 杭州 --degrees 硕士 --schools 985,211,QS100 --keyword 算法 --filter-recent-viewed true --target-count 3 --max-screened 30 --criteria "必须有ccf-a论文或会议成果，本科学历必须至少211及以上或者海外qs200院校" --post-action greet --max-greet-count 3 --execute-post-action --save-report .live-artifacts/phase10-search-criteria-greet-live.json`.
- Observed non-action result: filters applied and validated; `processed=22`; `detail_opened=21`; `llm_screened=21`; `llm_passed=3`.
- CV acquisition: Network-primary succeeded for 20 screened candidates; image fallback succeeded for 1 screened candidate with 6 unique full-CV scroll screenshots.
- CDP contract: `runtime_evaluate_used=false`; method log contained no `Runtime.*`.
- Invalidated post-action: saved clicked controls were whole search-result anchors with `ka=search_click_open_resume`, long candidate-card labels, and large row-sized boxes. They were not real detail-page greet controls. This run must not be counted as a search greet pass.
- Follow-up hardening: `src/domains/recruit/actions.js` no longer scans raw `a` elements, rejects external/href/open-resume anchors, and requires button-like short exact action labels; `scripts/live-search-phase10-full.js` no longer falls back to scanning the whole search iframe for actions.
- Required rerun before passing search greet: rerun with an explicit user-provided search job selection from the selector next to the keyword input. Mutating search runs now fail fast if `--execute-post-action` is used without `--job`.
- Greet quota safeguard: recommend and search/recruit click wrappers now parse `立即沟通(n/d)` and refuse to click when `n > d`; Phase 10 scripts stop with `reason=greet_credits_exhausted` so a run cannot continue spending greet attempts after Boss credits are exhausted. A non-mutating live probe on the current search detail read `立即沟通(30/135)`, parsed `exhausted=false`, and used no `Runtime.*`.
