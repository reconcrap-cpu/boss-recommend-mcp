---
name: "boss-recommend-pipeline"
description: "Use when users want Boss recommend-page filtering/screening via boss-recommend-mcp. Confirm required params first, then run in two-stage confirmation with strict recommend routing."
---

# Boss Recommend Pipeline Skill

## Goal

当用户要在 Boss 推荐页筛人时，必须走 `start_recommend_pipeline_run`，并按“两阶段确认 -> 页面就绪 -> 岗位确认 -> 最终确认 -> 执行”的顺序完成。2.0 CDP-only 路径不再支持 legacy recommend -> chat 自动衔接；若用户要聊天页筛选或求简历，必须在推荐页任务完成后显式改用 `boss-chat` 工具。

## Hard Rules (Must Follow)

- **路由**
  - 语义是推荐页（`recommend/推荐页/recommend page//web/chat/recommend`）时，只能走本 skill。
  - 语义是“推荐页找人 + 结束后沟通/聊天”时，先完成 recommend run；不得配置 `follow_up.chat`，后续聊天任务必须显式交给 `boss-chat`。
  - 只有用户**明确**说搜索页（`search/搜索页//web/chat/search`）时，才可转 `boss-recruit-pipeline`。
  - recommend 失败时（如 `JOB_TRIGGER_NOT_FOUND/NO_RECOMMEND_IFRAME/BOSS_LOGIN_REQUIRED`）禁止降级到 recruit；先修 recommend 页面就绪/登录态。

- **确认不可代填（强制）**
  - 禁止 agent 自行“设置合理参数”并代替用户确认。
  - 禁止在用户未明确回复前，把任意 `*_confirmed` 字段设为 `true`。
  - 禁止在用户未明确回复前，自行填充 `page_scope/school_tag/degree/gender/recent_not_view/criteria/target_count/post_action/max_greet_count/job/rest_level`。
  - 每次 run 必须明确询问用户本次休息强度 `rest_level`：`low`（旧策略）/ `medium`（约 5 小时或 700 人累计休息 30 分钟）/ `high`（约 5 小时或 700 人累计休息 1 小时）；不得默认使用配置文件里的值替用户决定。
  - 若工具返回 `pending_questions`，必须逐项向用户提问并等待用户回复；不得跳过提问直接执行。

- **岗位确认时机**
  - 页面未就绪前，禁止询问 `job`。
  - 仅当工具返回 `job_options` 后，才允许问 `job`，且必须展示全部选项。

- **参数确认**
  - `criteria` 必须是用户开放式自然语言；禁止“严格/宽松执行”等预设替代。
  - `post_action=greet` 时，必须确认 `max_greet_count`；禁止自动默认为 `target_count`。
  - 正式执行前必须 `final_confirmed=true`。
  - 真实筛选禁止传 `detail_limit: 0`；recommend 默认必须打开候选人详情/CV。只有用户明确要求“卡片-only 调试”时，才允许同时传 `detail_limit: 0` 和 `allow_card_only_screening: true`。

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
- `rest_level`：`low|medium|high`

### Stage B (页面就绪后)

必须确认：

- `job`（来自 `job_options`，必须全量展示）
- `final_review`（岗位 + 全参数总确认）

## Chat Handoff

当用户要求“推荐页跑完后继续聊天页任务”时：

- 本次 recommend run 只提交 recommend 参数，不要写 `follow_up.chat`。
- recommend 完成并由用户确认要继续后，切换到 `boss-chat` skill。
- `boss-chat` 会重新调用 `prepare_boss_chat_run` 获取聊天页岗位列表，并显式确认 `job/start_from/target_count/criteria`。
- 不得在 recommend run 尚未完成时并行启动 `start_boss_chat_run`。

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
  - `rest_level`: `low/medium/high`

## Tool Usage

- 岗位发现工具：`list_recommend_jobs`
  - 用途：当用户需要为 cron / 一次性自动任务提前填写完整参数时，先用它读取推荐页岗位下拉框的全部可用岗位名；默认会复用/自动打开本机 9222 Chrome 并导航到推荐页。
  - 输出：优先把 `job_names` 里的值作为后续 `overrides.job` / `confirmation.job_value`。
  - 限制：只读岗位列表，不启动筛选任务；若返回 `BOSS_LOGIN_REQUIRED`，必须让用户在自动打开的 Chrome 完成登录后重试，本次 cron 不得创建。
- Cron 准备工具：`prepare_recommend_pipeline_run`
  - 用途：只校验参数是否已可用于 cron / 一次性任务，不启动筛选任务。
  - 要求：只有返回 `status=READY` 且 `cron_ready=true` 后，才允许继续创建定时任务。
  - 若返回 `NEED_INPUT` / `NEED_CONFIRMATION` / `FAILED`：继续补齐 `pending_questions` 或修复登录/页面/config；不得先创建 cron。
- Cron 创建工具：`schedule_recommend_pipeline_run`
  - 用途：保存已经 READY 的完整 payload，并启动 package-owned detached scheduler；到点后由包内 worker 直接调用 `start_recommend_pipeline_run`。
  - 必填：同 `start_recommend_pipeline_run` 的完整 payload，另加 `schedule_delay_minutes` / `schedule_delay_seconds` / `schedule_run_at` 之一。
  - 成功标准：必须返回 `status=SCHEDULED`、`schedule_created=true`、`schedule_id`、`run_at`。只有这个返回后，才可以告诉用户定时任务已创建。
- Cron 查询工具：`get_recommend_scheduled_run`
  - 用途：用户问“任务是否启动/进度”时，先查 `schedule_id`。若到点后已启动，会返回内层 `run_id` 和 run 快照。
- 主工具：`start_recommend_pipeline_run`
- 必填：`instruction`
- 关键输入：
  - `confirmation`：`page_confirmed/page_value/filters_confirmed/school_tag_confirmed.../job_confirmed/job_value/final_confirmed`
  - `overrides`：`page_scope/school_tag/degree/gender/recent_not_view/criteria/job/target_count/post_action/max_greet_count`
  - `human_behavior`：必须包含本次用户确认的 `restLevel`（例如 `{ "restLevel": "medium" }`）
  - 不要传 `follow_up.chat`；该路径属于 legacy-only 行为

最小策略：

- 若返回 `NEED_INPUT` 或 `NEED_CONFIRMATION`：只追问 `pending_questions`。
- 已确认值不重复问；仅补缺口。
- 拿到 `ACCEPTED + run_id` 后默认停止本轮，不自动轮询。
- 在拿到 `ACCEPTED + run_id` 之前，禁止以“我已帮你确认参数”为由越过必填确认阶段。

## Cron / Scheduled Run Policy

创建 cron 时必须在设置 cron 的当下完成全部交互：

1. 锁定用户原始 instruction，不改写、不摘要，criteria 放入 `overrides.criteria` 时必须逐字保留。
2. 收集 Stage A 全部筛选项、`target_count`、`post_action`、`max_greet_count`（如需要）和本次 `rest_level`。
3. 调用 `list_recommend_jobs`；若 Chrome 未打开，工具会尝试自动打开本机 9222 Chrome 并进入推荐页。若返回 `BOSS_LOGIN_REQUIRED` 或页面不可用，停止 cron 创建，让用户登录/修复后重试。
4. 用 `job_names` 中的精确岗位名完成岗位确认，并完成最终总确认，写入 `job_confirmed=true` 与 `final_confirmed=true`。
5. 调用 `prepare_recommend_pipeline_run` 传入将来要执行的完整 payload；只有 `READY + cron_ready=true` 才能继续。
6. 立即调用 `schedule_recommend_pipeline_run`，传入同一份完整 payload 和 `schedule_delay_minutes` / `schedule_run_at`。禁止让 OpenClaw 自己写 `/tmp/*.log` shell cron、自然语言提醒、或未来对话回调来代替此工具。
7. 只有拿到 `SCHEDULED + schedule_id` 后才告诉用户定时任务已创建。回复必须包含 `schedule_id`，而不是只说“10 分钟后会启动”。
8. 到点后由 package-owned detached scheduler 启动；若 Chrome/登录异常，应作为 schedule/run 失败处理，不得再向用户追问参数。

Shell-only OpenClaw/QClaw cron 设置同样先运行 prepare：

```powershell
npx -y @reconcrap/boss-recommend-mcp@latest prepare-run --instruction-file .\boss-recommend-instruction.txt --overrides-file .\boss-recommend-overrides.json --confirmation-file .\boss-recommend-confirmation.json --slow-live --port 9222
```

仅当上述命令输出 `READY` 且 `cron_ready=true` 后，才允许继续创建定时任务。

然后必须用 package-owned scheduler 创建定时任务，不要手写系统 cron：

```powershell
npx -y @reconcrap/boss-recommend-mcp@latest schedule-run --schedule-delay-minutes 10 --instruction-file .\boss-recommend-instruction.txt --overrides-file .\boss-recommend-overrides.json --confirmation-file .\boss-recommend-confirmation.json --slow-live --port 9222
```

用户查询时：

```powershell
npx -y @reconcrap/boss-recommend-mcp@latest schedule-status --schedule-id <schedule_id>
```

## Async Run Policy

- 用户未明确要求“持续跟进”时，不自动 `sleep + get_recommend_pipeline_run`。
- 用户要求查进度时，再用 `get_recommend_pipeline_run`。
- **长任务轮询节奏（强制）**：
  - 推荐任务可能运行数小时，禁止高频轮询。
  - 默认最小轮询间隔为 **30 分钟**（除非用户明确要求更频繁）。
  - 若刚启动 run（拿到 `ACCEPTED + run_id`），不得立即进入连续轮询。
- `pause/resume/cancel` 必须复用同一 `run_id`，不要重复 `start`。
- **完成后衔接（强制）**：若用户手动触发 `get_recommend_pipeline_run` 且发现 recommend 已完成、而当前会话目标是“继续聊天沟通”且尚未启动 chat：切换到 `boss-chat` 并重新走 chat-only 参数确认。

## Preflight and Recovery

- 执行前必须通过：
  - `screening-config.json` 可用且非占位值（`baseUrl/apiKey/model`）
  - 工具可连接或自动启动本机 Chrome DevTools 端口（默认 `127.0.0.1:9222`）
  - Boss 已登录；若当前没有 9222 Chrome，工具会自动打开 Chrome 并导航到 `https://www.zhipin.com/web/chat/recommend`
  - 只有工具返回 `BOSS_LOGIN_REQUIRED` / `requires_login=true` 时，才要求用户人工登录 Boss 后重试

- 不要在运行前要求用户手动打开 9222 Chrome。只有这些情况需要人工介入：
  - 工具明确报告 `BOSS_LOGIN_REQUIRED`
  - 本机找不到 Chrome 可执行文件，并提示设置 `BOSS_MCP_CHROME_PATH` 或 `BOSS_RECOMMEND_CHROME_PATH`
  - 用户配置的是非本机 debug host，工具无法安全自动启动

- `PIPELINE_PREFLIGHT_FAILED` 处理顺序：
  1. 若 `screen_config` 失败：让用户提供真实 `baseUrl/apiKey/model`，并在 `guidance.config_path` 修改后明确回复“已修改完成”。
  2. 若有 `diagnostics.auto_repair`：优先按其结果继续。
  3. 否则使用 `diagnostics.recovery.agent_prompt`。
  4. 若无 `agent_prompt`：按顺序修复 `node_cli -> npm_dep_*`，每步后重跑 doctor。

## Featured / Latest Notes

- `featured`：必须 `search -> 切换精选 tab(data-status=3) -> screen`。
- `featured` 且缺少校准文件：先 `boss-recommend-mcp calibrate`。
- `latest`：流程同 `recommend`，但使用最新 tab 结构（`data-status=1`）。

## QClaw / Shell-Only Fallback

当 QClaw/OpenClaw 变体只暴露 shell、没有原生 MCP tool list 时，禁止停在“请使用 `start_recommend_pipeline_run` 工具”。必须用 shell 继续启动。

推荐做法：

1. 将锁定的用户原文写入 instruction 文件，将已确认参数写入 `overrides` 与 `confirmation` JSON 文件。
2. 先用 `prepare-run` 校验完整 payload 已 cron-ready；未返回 `READY + cron_ready=true` 不得创建定时任务或启动 run。
3. 若用户要“现在启动”，用 detached CLI 启动，让父命令返回启动证据，子进程继续持有 CDP 会话：

```powershell
npx -y @reconcrap/boss-recommend-mcp@latest run --detached --instruction-file .\boss-recommend-instruction.txt --overrides-file .\boss-recommend-overrides.json --confirmation-file .\boss-recommend-confirmation.json --slow-live --port 9222
```

4. 若用户要“稍后/cron/定时启动”，用 `schedule-run`，不是 `run --detached`。若 `schedule-run` 未返回 `SCHEDULED + schedule_id`，不得告诉用户定时任务已创建。
5. 若即时 `run --detached` 返回 `ACCEPTED + run_id`，即任务已启动；记录 `run_id/stdout_path/stderr_path`。若返回 `NEED_INPUT` 或 `NEED_CONFIRMATION`，说明设置阶段漏掉了准备门禁，应回到 `prepare-run` 补齐，不能在到点后继续问用户确认。

兼容路径：

- 若 `--detached` 不可用，或返回 `RECOMMEND_CLI_RUN_UNSUPPORTED_CDP_ONLY`，说明 npm/QClaw 仍在使用旧包；先运行 `npx -y @reconcrap/boss-recommend-mcp@latest install --agent qclaw` 并重启 QClaw。
- 在包更新未生效时，可以使用已验证过的直接 MCP stdio JSON-RPC 方式调用 `start_recommend_pipeline_run`；该方式等价于原生 MCP tool 调用，不能改用 recruit/search 路径。

普通 MCP 可用时：

`start_recommend_pipeline_run` 仍是首选。

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
- 若错误是 `BOSS_LOGIN_REQUIRED`，提示用户在自动打开的 Chrome 窗口完成登录，然后原参数重试；不要改用 search/recruit 路径。
