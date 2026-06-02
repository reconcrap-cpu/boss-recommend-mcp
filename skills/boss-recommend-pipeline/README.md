# Boss Recommend Pipeline Skill

用于 Boss 推荐页的人选筛选流水线。

核心规则：

- 先确认推荐页 filters
- 再确认筛选 criteria
- 再确认本次运行统一动作 `greet` 或 `none`
- 每次运行都要让用户明确选择休息强度 `low` / `medium` / `high`，并传入 `human_behavior.restLevel`
- 只确认一次 `post_action`，不要逐个候选人反复确认
- 运行中临时中断请使用 `pause_recommend_pipeline_run`（按 run_id），不要靠自然语言“暂停/继续”指令
- 继续执行请使用 `resume_recommend_pipeline_run`；状态查询默认按用户指令触发，不自动轮询
