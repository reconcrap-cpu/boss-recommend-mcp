---
name: "boss-recommend-pipeline"
description: "Use when users ask to run Boss recommend-page filtering and screening via boss-recommend-mcp; confirm filters, criteria, optional target_count, and run-level post_action (plus max_greet_count when post_action=greet) before execution."
---

# Boss Recommend Pipeline Skill

## Purpose

当用户希望在 Boss 推荐页按条件筛选候选人时，优先调用 MCP 工具 `run_recommend_pipeline` 完成端到端任务：

1. 解析推荐页筛选指令
2. 结构化推荐页 filters
3. 确认筛选 criteria
4. 在运行开始时询问 `target_count`（可选，可留空）
5. 在运行开始时一次性确认 `post_action`
6. 若 `post_action=greet`，同时确认 `max_greet_count`
7. 执行 recommend-search-cli 与 recommend-screen-cli
8. 返回结果摘要

## Required Confirmation

在真正执行前，必须先确认：

- 学校标签（`school_tag`）
- 学历（`degree`）
- 性别（`gender`）
- 是否过滤近14天已看（`recent_not_view`）
- screening criteria 是否正确
- `target_count`（目标筛选人数）是否需要设置（可不设上限）
- `post_action` 是否确定为 `favorite` 或 `greet`
- 当 `post_action=greet` 时，`max_greet_count`（最多打招呼人数）是否确定

`post_action` 的确认是**单次运行级别**的：

- 若用户确认 `favorite`，则本次运行中所有通过人选都统一收藏
- 若用户确认 `greet`，则本次运行中先按 `max_greet_count` 执行打招呼，超出上限后自动改为收藏
- 不要在每位候选人通过后再次逐个确认

## Tool Contract

- Tool name: `run_recommend_pipeline`
- Input:
  - `instruction` (required)
  - `confirmation`
    - `filters_confirmed`
    - `school_tag_confirmed`
    - `degree_confirmed`
    - `gender_confirmed`
    - `recent_not_view_confirmed`
    - `criteria_confirmed`
    - `target_count_confirmed`
    - `target_count_value` (integer, optional)
    - `post_action_confirmed`
    - `post_action_value` (`favorite|greet`)
    - `max_greet_count_confirmed`
    - `max_greet_count_value` (integer)
  - `overrides`
    - `school_tag`
    - `degree`（可传单值或数组；如“本科及以上”应展开为 `["本科","硕士","博士"]`）
    - `gender`
    - `recent_not_view`
    - `criteria`
    - `target_count`
    - `post_action`
    - `max_greet_count`

## Execution Notes

- 推荐页筛选入口在 recommend 页面，不是 search 页面。
- recommend-search-cli 只负责应用推荐页筛选项。
- recommend-screen-cli 负责滚动推荐列表、打开详情、提取完整简历图、调用多模态模型判断，并按单次确认的 `post_action` 执行收藏或打招呼。
- 详情页处理完成后必须关闭详情页并确认已关闭。

## Fallback

如果 MCP 不可用，改用：

`boss-recommend-mcp run --instruction "..." [--confirmation-json '{...}'] [--overrides-json '{...}']`

CLI fallback 的状态机与 MCP 保持一致：

- `NEED_INPUT`
- `NEED_CONFIRMATION`
- `COMPLETED`
- `FAILED`

## Setup Checklist

执行前先检查：

- `boss-recommend-mcp` 是否已安装
- `screening-config.json` 是否存在且包含可用模型配置
- Chrome 远程调试端口是否可连
- 当前 Chrome 是否停留在 `https://www.zhipin.com/web/chat/recommend`

## Preflight 失败自动修复

当工具返回 `status=FAILED` 且 `error.code=PIPELINE_PREFLIGHT_FAILED` 时：

1. 优先读取 `diagnostics.recovery.agent_prompt`，直接把这段提示词交给 AI agent 执行环境修复。
2. 若 `diagnostics.recovery.agent_prompt` 不存在，使用下面的兜底提示词（严格顺序，不可跳步）：

```text
你是环境修复 agent。请根据 diagnostics.checks 修复依赖，必须串行执行：
1) 若 node_cli 失败：先安装 Node.js >=18，未成功前禁止执行 npm install。
2) 若任意 npm_dep_* 失败：再安装 npm 依赖（chrome-remote-interface / ws）。
3) 若 python_cli 失败：安装 Python，并确保 python 命令可用。
4) 若 python_pillow 失败：最后执行 python -m pip install pillow。
每一步完成后重新运行 doctor，全部通过后再重试 run_recommend_pipeline。
```

安装顺序约束（必须遵守）：

- 没有 Node.js 时，不能先装 npm 包
- 没有 Python 时，不能先装 Pillow

## Response Style

- 用结构化中文输出
- 先给用户确认卡片，再正式执行
- 对 `school_tag/degree/gender/recent_not_view` 必须逐项提问并逐项确认，不可合并成一句“filters已确认”
- 不要跳过 `post_action` 的首轮确认
- 不要把 recommend 流程说成 search 流程
