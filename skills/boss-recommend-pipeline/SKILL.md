---
name: "boss-recommend-pipeline"
description: "Use when users want Boss recommend-page filtering/screening via boss-recommend-mcp. Confirm required params first, then run in two-stage confirmation with strict recommend routing."
---

# Boss Recommend Pipeline Skill

## Goal

当用户要在 Boss 推荐页筛人时，必须走 `start_recommend_pipeline_run`，并按“两阶段确认 -> 页面就绪 -> 岗位确认 -> 最终确认 -> 执行”的顺序完成。若用户还要求筛完后自动进入聊天页 follow-up，则必须把 chat 要求放进同一个 recommend run 的 `follow_up.chat`，不要要求单独再安装 `boss-chat`。

## Hard Rules (Must Follow)

- **路由**
  - 语义是推荐页（`recommend/推荐页/recommend page//web/chat/recommend`）时，只能走本 skill。
  - 语义是“推荐页找人 + 结束后沟通/聊天”时，仍然只能走本 skill；必须通过 `follow_up.chat` 挂到同一个 recommend run。
  - 只有用户**明确**说搜索页（`search/搜索页//web/chat/search`）时，才可转 `boss-recruit-pipeline`。
  - recommend 失败时（如 `JOB_TRIGGER_NOT_FOUND/NO_RECOMMEND_IFRAME/BOSS_LOGIN_REQUIRED`）禁止降级到 recruit；先修 recommend 页面就绪/登录态。

- **确认不可代填（强制）**
  - 禁止 agent 自行“设置合理参数”并代替用户确认。
  - 禁止在用户未明确回复前，把任意 `*_confirmed` 字段设为 `true`。
  - 禁止在用户未明确回复前，自行填充 `page_scope/school_tag/degree/gender/recent_not_view/criteria/target_count/post_action/max_greet_count/job/follow_up.chat.*`。
  - 若工具返回 `pending_questions`，必须逐项向用户提问并等待用户回复；不得跳过提问直接执行。

- **岗位确认时机**
  - 页面未就绪前，禁止询问 `job`。
  - 仅当工具返回 `job_options` 后，才允许问 `job`，且必须展示全部选项。

- **参数确认**
  - `criteria` 必须是用户开放式自然语言；禁止“严格/宽松执行”等预设替代。
  - `post_action=greet` 时，必须确认 `max_greet_count`；禁止自动默认为 `target_count`。
  - 正式执行前必须 `final_confirmed=true`。

- **Instruction 原文锁定**
  - 首次用户需求原文锁定为 `locked_instruction_raw`。
  - 后续所有调用复用原文，禁止改写/翻译/摘要。
  - 最终执行前逐字回显将提交的 `instruction`；若与锁定值不一致，先修正再执行。
  - 禁止在中途把用户意图拆成“recommend 已默认确认 + chat 单独执行”两条链路。

## Two-Stage Confirmation

### Stage A (页面就绪前，禁止问岗位)

必须确认：

- `page_scope`：`recommend|latest|featured`
- `school_tag`（多选）
- `degree`（多选）
- `gender`
- `recent_not_view`
- `criteria`（开放文本）
- `target_count`（可空）
- `post_action`：`favorite|greet|none`
- `max_greet_count`（仅当 `post_action=greet`）

### Stage B (页面就绪后)

必须确认：

- `job`（来自 `job_options`，必须全量展示）
- `final_review`（岗位 + 全参数总确认；若有 `follow_up.chat`，必须把 chat summary 一并展示）

## Follow-up Chat

当用户要求“推荐页跑完后自动开始聊天页任务”时：

- 仍然只走 `start_recommend_pipeline_run`
- 把 chat 配置放入顶层 `follow_up.chat`
- `follow_up.chat` 必填：
  - `criteria`
  - `start_from`: `unread|all`
  - `target_count`
- `follow_up.chat` 可选：
  - `profile`（默认 `default`）
  - `dry_run/no_state/safe_pacing/batch_rest_enabled`
- `job` / `port` 继承 recommend run 上下文；不要单独向用户再要一份
- LLM 配置固定复用 recommend 的 `screening-config.json`；不要单独向用户再要 `baseUrl/apiKey/model`
- 缺少 `follow_up.chat` 必填项时，按 `pending_questions` 补缺口；不要额外发起一轮独立的 chat 确认流程
- 不允许提前调用 `start_boss_chat_run`；必须等 recommend run 完成并由 `follow_up.chat` 自动衔接

## Closed vs Open Questions

- 封闭式字段（除 `criteria/target_count/max_greet_count/job`）必须提供完整可选项，不让用户盲填。
- 若工具已返回 `pending_questions[].options`，优先原样使用。
- 若未返回，则按下列枚举展示：
  - `page_scope`: `recommend/latest/featured`
  - `school_tag`: `不限/985/211/双一流院校/留学/国内外名校/公办本科`
  - `degree`: `不限/初中及以下/中专/中技/高中/大专/本科/硕士/博士`
  - `gender`: `不限/男/女`
  - `recent_not_view`: `不限/近14天没有`
  - `post_action`: `favorite/greet/none`

## Tool Usage

- 主工具：`start_recommend_pipeline_run`
- 必填：`instruction`
- 关键输入：
  - `confirmation`：`page_confirmed/page_value/filters_confirmed/school_tag_confirmed.../job_confirmed/job_value/final_confirmed`
  - `overrides`：`page_scope/school_tag/degree/gender/recent_not_view/criteria/job/target_count/post_action/max_greet_count`
  - `follow_up.chat`：仅在“recommend 完成后自动进入 boss-chat”场景传入

最小策略：

- 若返回 `NEED_INPUT` 或 `NEED_CONFIRMATION`：只追问 `pending_questions`。
- 已确认值不重复问；仅补缺口。
- 拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动轮询。
- 在拿到 `ACCEPTED + run_id` 之前，禁止以“我已帮你确认参数”为由越过必填确认阶段。

## Async Run Policy

- 用户未明确要求“持续跟进”时，不自动 `sleep + get_recommend_pipeline_run`。
- 若 run 已进入 `chat_followup`，默认也不得自动轮询子 chat 状态；除非用户明确指定轮询频率/间隔。
- 用户要求查进度时，再用 `get_recommend_pipeline_run`。
- **长任务轮询节奏（强制）**：
  - 推荐+聊天联动任务可能运行数小时，禁止高频轮询。
  - 默认最小轮询间隔为 **30 分钟**（除非用户明确要求更频繁）。
  - 若刚启动 run（拿到 `ACCEPTED + run_id`），不得立即进入连续轮询。
- `pause/resume/cancel` 必须复用同一 `run_id`，不要重复 `start`。
- **完成后衔接（强制）**：
  - 若本次 run 已带 `follow_up.chat`：chat 由同一 run 自动衔接，禁止再单独重复启动 chat run。
  - 若用户手动触发 `get_recommend_pipeline_run` 且发现 recommend 已完成、而当前会话目标是“继续聊天沟通”且尚未启动 chat：应立即启动 chat（无需等待下一轮 30 分钟轮询）。

## Preflight and Recovery

- 执行前必须通过：
  - `screening-config.json` 可用且非占位值（`baseUrl/apiKey/model`）
  - Chrome DevTools 端口可连
  - Boss 已登录且位于 `https://www.zhipin.com/web/chat/recommend`

- `PIPELINE_PREFLIGHT_FAILED` 处理顺序：
  1. 若 `screen_config` 失败：让用户提供真实 `baseUrl/apiKey/model`，并在 `guidance.config_path` 修改后明确回复“已修改完成”。
  2. 若有 `diagnostics.auto_repair`：优先按其结果继续。
  3. 否则使用 `diagnostics.recovery.agent_prompt`。
  4. 若无 `agent_prompt`：按顺序修复 `node_cli -> npm_dep_*`，每步后重跑 doctor。

## Featured / Latest Notes

- `featured`：必须 `search -> 切换精选 tab(data-status=3) -> screen`。
- `featured` 且缺少校准文件：先 `boss-recommend-mcp calibrate`。
- `latest`：流程同 `recommend`，但使用最新 tab 结构（`data-status=1`）。

## Fallback CLI

MCP 不可用时：

`npx -y @reconcrap/boss-recommend-mcp@latest run --instruction "..." [--confirmation-json '{...}'] [--overrides-json '{...}'] [--follow-up-json '{...}']`

禁止错误回退：

- 不得切到 `boss-recruit-mcp` 或 `run_recruit_pipeline`。
- 不得用 `boss-recruit-mcp doctor` 检查 recommend 流程。

## Response Style

- 用结构化中文。
- 第一轮确认卡片不出现 `job`。
- 仅在 `job_options` 出现后给岗位确认卡片，且岗位选项必须全量。
- 封闭式问题必须带完整标签选项；开放式问题（如 `criteria`）保持自由输入。
- 页面就绪失败提示必须包含 `debug_port`、recommend URL、以及登录 URL（若未登录）：
  - `https://www.zhipin.com/web/chat/recommend`
  - `https://www.zhipin.com/web/user/?ka=bticket`
