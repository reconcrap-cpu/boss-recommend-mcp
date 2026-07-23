# Recruiting Run Monitor V1 integration

Boss recommend, search, and chat publish an additive V1 projection for the
standalone recruiting run monitor. The legacy run state remains authoritative;
monitor persistence failures never interrupt candidate processing.

## Runtime settings

```text
BOSS_MONITORING_ENABLED=true
BOSS_MONITOR_HOME=<provider-owned projection directory>
RECRUITING_MONITOR_HOME=<standalone daemon runtime directory>
RECRUITING_MONITOR_URL=http://127.0.0.1:47831
RECRUITING_MONITOR_LINK_SECRET=<shared 32-byte-or-longer secret>
```

When disabled, the projection writer is a no-op. The provider adapter is exported
without startup side effects:

```js
import {
  createMonitorProvider
} from "@reconcrap/boss-recommend-mcp/monitor-provider";
```

The adapter implements `RecruitingRunProviderV1` from
`@reconcrap/recruiting-run-monitor-contract@1.0.0`.

## Public projection

```text
%BOSS_MONITOR_HOME%/
  v1/
    provider.json
    runs/
      recommend/<run_id>/snapshot.json
      recommend/<run_id>/events.ndjson
      search/<run_id>/snapshot.json
      search/<run_id>/events.ndjson
      chat/<run_id>/snapshot.json
      chat/<run_id>/events.ndjson
```

Each run also has private command, writer-lock, evidence-locator, and worker-exit
metadata beneath its projection directory. Evidence locator records contain only a
provider-owned reference; screenshot/model bytes are never copied into the monitor.

Only runs carrying the source marker
`monitoring_v1.contract_version == "1.0"` or created by a V1 producer are projected.
Reading an older legacy run does not import it.

## Start and get responses

Successful recommend, search, and chat start/get responses include:

```json
{
  "monitoring": {
    "ref": {
      "provider": "boss",
      "kind": "recommend",
      "run_id": "..."
    },
    "contract_version": "1.0",
    "availability": "ready",
    "dashboard_url": "http://127.0.0.1:47831/access/<one-time-ticket>"
  }
}
```

The URL is returned but never opened automatically. `availability` is `ready`
only when the monitor's atomic `daemon.json` names the Boss provider, has a live
PID and valid instance ID, carries a heartbeat no older than 15 seconds, matches
the configured loopback URL, and fingerprints the same signing secret. If any
check fails, `dashboard_url` is `null`.

No dashboard-specific tool is added to the existing recommend, recruit, or chat
MCP toolsets.

## Durability and controls

- Phase/progress changes are projected immediately; an active producer refreshes
  liveness every five seconds.
- Installation-marker and projection failures are fail-closed and nonfatal:
  recruiting state continues to persist, an incomplete V1 marker is omitted, and
  a later healthy lifecycle write can backfill from the authoritative journal.
- Per-run writer locks serialize cross-process revisions and event sequences.
- The newest terminal generation supersedes any older heartbeat and is retried
  after a nonfatal projection failure.
- Search/chat candidate results use the same fsynced append-only journal pattern as
  recommend. Persisted checkpoints and run-state files retain only bounded tails;
  reports reconstruct from the journal.
- Pause, resume, and cancel are serialized per run. Commands require an
  idempotency key and expected snapshot revision; one revision can trigger at most
  one legacy control action.
- Evidence IDs are bound to a candidate. Paths are canonicalized under configured
  Boss roots, and symlink, traversal, oversized, and invalid-MIME inputs fail
  closed.

## Local validation

Use isolated homes for every command:

```powershell
$env:BOSS_RECOMMEND_HOME = "C:\isolated\runtime\boss-recommend"
$env:BOSS_RECRUIT_HOME = "C:\isolated\runtime\boss-recruit"
$env:BOSS_MONITOR_HOME = "C:\isolated\runtime\boss-monitor-projection"
$env:RECRUITING_MONITOR_HOME = "C:\isolated\runtime\recruiting-monitor"
npm run test:monitor
```

The final browser smoke requires explicit user authorization and must use the
isolated Chrome profile on port `9322`, `post_action=none`, and no greeting,
favorite, CV-request, or message action.
