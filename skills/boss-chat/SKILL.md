---
name: "boss-chat"
description: "Use when users want Boss chat-page screening/outreach via the bundled boss-chat runtime inside boss-recommend-mcp."
---

# Boss Chat Skill

## Goal

当用户要在 Boss 聊天页单独跑筛选/沟通任务时，必须走内置的 chat 工具，而不是要求用户单独安装 `boss-chat`。

适用范围是“chat-only 会话”。若用户意图包含推荐页找人（尤其是“先推荐再沟通”），必须让 `boss-recommend-pipeline` 接管，并通过 `follow_up.chat` 完成联动。

## Tool Routing

- 健康检查：`boss_chat_health_check`
- 预备并获取岗位列表：`prepare_boss_chat_run`
- 启动异步任务：`start_boss_chat_run`
- 查询进度：`get_boss_chat_run`
- 暂停：`pause_boss_chat_run`
- 继续：`resume_boss_chat_run`
- 取消：`cancel_boss_chat_run`

## Required Inputs

- `job`
- `start_from`: `unread|all`
- `target_count`
- `criteria`

可选：

- `profile`（默认 `default`）
- `port`
- `dry_run`
- `no_state`
- `safe_pacing`
- `batch_rest_enabled`

`target_count` 填写规则（关键）：

- 正整数：如 `20`
- 扫到底：`all` / `-1` / `unlimited` / `全部` / `不限` / `扫到底` / `全量`
- 同义短语也可直接用：`全部候选人` / `所有候选人`（等价于扫到底）

## Hard Rules

- LLM 配置必须复用 `boss-recommend-mcp` 的 `screening-config.json`；不要再向用户单独要 `baseUrl/apiKey/model`。
- 路由护栏（强制）：
  - 只在用户明确是 chat-only 任务时使用本 skill。
  - 只要用户提到推荐页、先找人后沟通、或需要推荐筛选阶段，禁止调用 `start_boss_chat_run`；必须交给 `boss-recommend-pipeline` 并走 `follow_up.chat`。
  - 不得在 recommend 任务尚未完成时并行启动独立 chat run。
- `job` / `start_from` / `criteria` 缺一不可；缺参时只补缺口。
- `target_count` 在 chat-only 启动前也是必填项，不能默认省略。
- 当用户说“全部候选人/所有候选人”时，必须按“扫到底（unlimited）”处理，不要再追问正整数。
- 参数名必须写 `target_count`（不要写“目标数量”等中文键名）。
- 当用户选择“扫到底/全部候选人/所有候选人”时，调用参数优先写：`"target_count": "all"`；`-1` 只作为兼容输入和内部 CLI 表示。
- 禁止 agent 自行补全 `job/start_from/criteria` 并直接执行，必须由用户明确给出或确认。
- chat-only 启动流程必须先进入聊天页并拉取岗位列表，再让用户从列表中选择 `job`。
- 必须先用空参调用 `prepare_boss_chat_run` 获取 `job_options`；不要用 `start_boss_chat_run` 做预备调用。
- `start_boss_chat_run` 只能用于真正启动，必须一次性传齐 `job` / `start_from` / `target_count` / `criteria`。
- 若 `start_boss_chat_run` 返回 `NEED_INPUT` 且 `missing_fields` 包含 `target_count`，说明你没有把用户选择写入工具参数；下一次调用必须照 `next_call_example` 原样补上 `"target_count": "all"` 或正整数，不要重复空调用。
- 默认不自动轮询；只有用户要求查进度时才调用 `get_boss_chat_run`。
- `start_boss_chat_run` 返回 `ACCEPTED` 后，默认立即结束当前回合，不得主动连续调用 `get_boss_chat_run`。
- 只有当用户明确给出“轮询频率/间隔”（例如“每30分钟查一次”）时，才允许按该频率查询进度。
- 长任务场景禁止高频轮询；若需持续观察，默认按 30 分钟间隔查询一次状态（除非用户明确要求更频繁）。
- `pause/resume/cancel` 必须复用同一个 `run_id`。

## Handoff Rule (Recommend -> Chat)

- 若用户先运行了 recommend 流水线，并在手动状态检查时确认 recommend 已完成，且用户目标是“立即进入聊天沟通”：
  - 若该 recommend run **未配置** `follow_up.chat`：应立即调用 `start_boss_chat_run` 启动 chat（不要等下一次 30 分钟轮询）。
  - 若该 recommend run **已配置** `follow_up.chat`：不要再重复新开 chat run，改为查询同一父 run / 子 run 状态。

## Response Style

- 用结构化中文。
- 首轮建议先调用一次 `prepare_boss_chat_run`（可空参）获取 `job_options` 与 `pending_questions`。
- 缺参时必须逐项确认：`job`（来自岗位列表）、`start_from`（`unread|all`）、`target_count`、`criteria`。
- 若健康检查失败，明确提示共享配置文件 `screening-config.json` 不可用。
