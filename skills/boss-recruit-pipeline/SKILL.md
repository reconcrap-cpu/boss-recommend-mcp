---
name: "boss-recruit-pipeline"
description: "Use when users want Boss search/recruit-page screening via the unified boss-recommend-mcp package. Replaces the legacy boss-recruit-mcp skill."
---

# Boss Recruit Pipeline Skill

## Goal

当用户要在 Boss 搜索页 / 招聘搜索页筛人时，必须走 `@reconcrap/boss-recommend-mcp` 2.x 内置的 recruit/search MCP 工具，不要安装或调用旧的 `@reconcrap/boss-recruit-mcp`。

## Tool Routing

Trae/Trae-CN split-server config exposes these under the `boss-recruit` MCP server. Search/recruit tasks should call `boss-recruit/<tool>` when the host shows server-qualified tool names.

- 同步启动：`run_recruit_pipeline`
- 异步启动：`start_recruit_pipeline_run`
- 查询进度：`get_recruit_pipeline_run`
- 暂停：`pause_recruit_pipeline_run`
- 继续：`resume_recruit_pipeline_run`
- 取消：`cancel_recruit_pipeline_run`

If the visible tool surface only offers `boss-recommend/*` for a search/recruit task, stop and report a tool-surface/config error. Do not call `boss-recommend/list_recommend_jobs`, `boss-recommend/run_recommend`, or `boss-recommend/start_recommend_pipeline_run` as a fallback for search.

## Hard Rules

- 只在用户明确说搜索页、search、recruit、招聘搜索、`/web/chat/search` 时使用本 skill。
- 如果用户说推荐页、recommend、`/web/chat/recommend`，必须交给 `boss-recommend-pipeline`。
- 如果用户说聊天页、未读、全部聊天、求简历，必须交给 `boss-chat`。
- 禁止调用旧包：`@reconcrap/boss-recruit-mcp`、`boss-recruit-mcp`、旧本地 recruit repo、旧 vendor 脚本。
- 浏览器自动化必须走 CDP-only 2.x MCP 工具；不得要求用户启用 legacy page-JS 或 `Runtime.evaluate` 路径。
- 启动 search/recruit run 时，若本机默认 `127.0.0.1:9222` Chrome DevTools 端口不可连，工具会自动打开 Chrome 并导航到 `https://www.zhipin.com/web/chat/search`。
- 只有工具返回 `BOSS_LOGIN_REQUIRED` / `requires_login=true` 时，才要求用户在自动打开的 Chrome 窗口人工登录 Boss 后重试；不要把“没开 9222 Chrome”当作缺参。
- 若本机找不到 Chrome，可提示用户设置 `BOSS_MCP_CHROME_PATH` 或 `BOSS_RECOMMEND_CHROME_PATH`；非本机 debug host 不自动启动。
- 若用户未提供岗位，必须先询问岗位。搜索页岗位选择在关键词输入框旁边；不要猜测默认岗位。
- 搜索页任务不要调用 `list_recommend_jobs` 获取岗位；推荐页岗位列表和搜索页岗位选择不是同一个工具面。用户已经给出岗位时直接传 `overrides.job`。
- 若用户提供城市、学历、学校、关键词、过滤已看、人选目标数、筛选条件等参数，必须逐项传入或确认。
- 搜索页和推荐页一样支持多选筛选条件；不要把多选降级成单选。
- 每次 run 必须明确询问用户本次休息强度 `rest_level`：`low`（旧策略）/ `medium`（约 5 小时或 700 人累计休息 30 分钟）/ `high`（约 5 小时或 700 人累计休息 1 小时）；不得默认使用配置文件里的值替用户决定。
- 启动前展示一次包含岗位、关键词、城市、学历、学校标签、是否过滤已看、是否过滤近期同事触达、criteria、目标人数、后置动作和休息强度的总确认；用户确认后，`confirmation` 只需要 `{ "final_confirmed": true }`。
- 不要让工具重写用户的 `criteria`。用户给出 `筛选条件` / `筛选标准` / `硬条件` 时，逐字写入 `overrides.criteria`；不要传系统简化版。
- 用户说学校类型“不限”时，在 `overrides.school_tag` 显式传 `"不限"` 或在 `overrides.schools` 传 `[]`；不要因为 criteria 里出现 `985/211/双一流` 就把它们当作搜索页学校过滤器。
- 用户说只看未查看“不限”时，在 `overrides.recent_not_view` 显式传 `"不限"` 或在 `overrides.filter_recent_viewed` 传 `false`。
- “只看未查看/过滤已看”只控制 Boss 的“过滤近14天查看”筛选；“是否过滤近期同事触达”是单独输入，写入 `overrides.filter_recent_colleague_contacted` 或兼容字段 `overrides.skip_recent_colleague_contacted`。用户说近期同事触达“不限/不过滤”时传 `false`；用户说过滤近期同事触达/跳过同事已联系时传 `true`。

## Required Inputs

- `job`
- `keyword` 或用户明确的搜索意图
- `criteria`
- `target_count`
- `rest_level`: `low|medium|high`

常用可选项：

- `city`
- `degree`
- `school_tag`
- `recent_not_view`
- `filter_recent_colleague_contacted`
- `port`

## Confirmation Flow

1. 先从用户原始消息里提取参数；缺什么只问什么。不要先调用 MCP 让工具猜缺参。
2. `criteria` 必须来自用户明确提供的筛选条件，或来自你向用户追问后得到的完整自然语言标准。禁止把岗位、关键词、学历等字段拼成 criteria。
3. 如果用户一开始已经给齐 `job`、`keyword`、`criteria`、`target_count`、`rest_level`，并且可选筛选项也已明确或确认不限，直接展示一次总确认。
4. 用户确认后调用 `boss-recruit/start_recruit_pipeline_run` 或 `boss-recruit/run_recruit_pipeline`，传：
   - `confirmation: { "final_confirmed": true }`
   - 所有规范化字段放在 `overrides`
   - 完整 criteria 放在 `overrides.criteria`
   - 本次休息强度放在 `human_behavior.restLevel`
5. 工具返回 `NEED_INPUT` 时，按 `pending_questions` 只补具体缺口；不要接受或转述工具生成的简化 criteria。

启动工具时，把用户确认的休息强度写入 `human_behavior.restLevel`，例如：

```json
{
  "confirmation": { "final_confirmed": true },
  "human_behavior": { "restLevel": "medium" }
}
```

## Response Style

- 用结构化中文确认参数。
- 缺参时只补缺口，不要改写用户的筛选条件。
- 拿到 `ACCEPTED + run_id` 后默认停止本轮，不主动高频轮询。
- 查询、暂停、恢复、取消时必须复用同一个 `run_id`。
