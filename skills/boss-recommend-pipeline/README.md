# Boss Recommend Pipeline Skill

用于 Boss 推荐页的人选筛选流水线。

核心规则：

- 先确认推荐页 filters
- 再确认筛选 criteria
- 再确认本次运行统一动作 `favorite` 或 `greet`
- 只确认一次 `post_action`，不要逐个候选人反复确认
