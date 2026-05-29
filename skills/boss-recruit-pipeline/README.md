# boss-recruit-pipeline

Bundled search/recruit-page automation skill shipped with `boss-recommend-mcp` 2.x.

Package: `@reconcrap/boss-recommend-mcp` (npm)
Source: `https://github.com/reconcrap-cpu/boss-recommend-mcp`

This skill intentionally replaces legacy `boss-recruit-mcp` skill installs. It routes Boss search/recruit tasks to the unified CDP-only MCP tools:

- `run_recruit_pipeline`
- `start_recruit_pipeline_run`
- `get_recruit_pipeline_run`
- `pause_recruit_pipeline_run`
- `resume_recruit_pipeline_run`
- `cancel_recruit_pipeline_run`

Do not call the old `@reconcrap/boss-recruit-mcp` package from this skill.

Each run must ask the user to choose `rest_level` (`low` / `medium` / `high`) and pass the answer as `human_behavior.restLevel`; do not pick a default for the user.
