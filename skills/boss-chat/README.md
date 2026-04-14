# boss-chat

Bundled chat-page automation skill shipped with `boss-recommend-mcp`.

Package: `@reconcrap/boss-recommend-mcp` (npm)
Source: `https://github.com/reconcrap-cpu/boss-recommend-mcp`

Use this skill when the user wants a chat-only Boss workflow without installing `boss-chat` separately.

## Stable Prompt Template (Trae-CN)

Use the following prompt when host agents are prone to loop detection in long conversations:

```text
Please run a Boss chat-only task (do not switch to recommend flow).

Execution order:
1) Call boss_chat_health_check.
2) Call prepare_boss_chat_run once (empty params allowed) to fetch job_options and missing fields.
3) Ask for these required fields in one shot: job, start_from (unread/all), target_count, criteria.
4) After user reply, call start_boss_chat_run exactly once to start the run.
5) If ACCEPTED, reply only with run_id and "task started"; no auto polling.

Anti-loop rules:
- Do not repeat the same sentence across turns.
- On validation errors, list all missing/invalid fields once.
- Do not use start_boss_chat_run for preflight. It is only for the final start call and must include job/start_from/target_count/criteria.
- Do not call start_boss_chat_run repeatedly in one turn.
- Do not call get_boss_chat_run unless user explicitly asks for progress.

target_count mapping:
- Positive integer means explicit cap (for example 20).
- `all` / `-1` / `unlimited` / `全部` / `不限` / `扫到底` / `全量` means unlimited.
- `全部候选人` / `所有候选人` must also be treated as unlimited.
- Always write the argument key as `target_count`.
- For unlimited mode, prefer `"target_count": "all"` in the tool call; `-1` is accepted for compatibility and used internally by the CLI.
- If start_boss_chat_run returns NEED_INPUT for `target_count`, the previous tool call omitted the argument. Retry once using `next_call_example` and include `"target_count": "all"` or a positive integer.
```
