---
name: "boss-recruit-pipeline"
description: "Use when users want Boss search/recruit-page screening via the unified boss-recommend-mcp package. Replaces the legacy boss-recruit-mcp skill."
---

# Boss Recruit Pipeline Skill

## Goal

当用户要在 Boss 搜索页 / 招聘搜索页筛人时，必须走 `@reconcrap/boss-recommend-mcp` 2.x 内置的 recruit/search MCP 工具，不要安装或调用旧的 `@reconcrap/boss-recruit-mcp`。

## Tool Routing

- 同步启动：`run_recruit_pipeline`
- 异步启动：`start_recruit_pipeline_run`
- 查询进度：`get_recruit_pipeline_run`
- 暂停：`pause_recruit_pipeline_run`
- 继续：`resume_recruit_pipeline_run`
- 取消：`cancel_recruit_pipeline_run`

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
- 若用户提供城市、学历、学校、关键词、过滤已看、人选目标数、筛选条件、post action、max greet 等参数，必须逐项传入或确认。
- `post_action=greet` 时必须确认 `max_greet_count`；不要默认等于 `target_count`。
- 搜索页和推荐页一样支持多选筛选条件；不要把多选降级成单选。
- 每次 run 必须明确询问用户本次休息强度 `rest_level`：`low`（旧策略）/ `medium`（约 5 小时或 700 人累计休息 30 分钟）/ `high`（约 5 小时或 700 人累计休息 1 小时）；不得默认使用配置文件里的值替用户决定。

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
- `post_action`
- `max_greet_count`
- `port`

启动工具时，把用户确认的休息强度写入 `human_behavior.restLevel`，例如：

```json
{ "human_behavior": { "restLevel": "medium" } }
```

## Response Style

- 用结构化中文确认参数。
- 缺参时只补缺口，不要改写用户的筛选条件。
- 拿到 `ACCEPTED + run_id` 后默认停止本轮，不主动高频轮询。
- 查询、暂停、恢复、取消时必须复用同一个 `run_id`。
