# Stability and data reporting review — 2026-09-09

Changes are local. No Homey app installation, device communication, database requests, app release version changes, Git commits, or remote writes were performed. Tests use mocked HTTP, Homey APIs, SDK wiring, and timers. Real Homey/InfluxDB runtime behavior remains unverified.

## Fixes and changed files

| Files | Defect and resulting behavior |
| --- | --- |
| `lib/InfluxDb.mjs` | HTTP errors previously counted as successful writes; pending writes overlapped; network failures inserted an array inside the measurement array. Writes now await HTTP 204, preserve flat ordered batches until acknowledgement, and share one bounded queue with Insights exports. |
| `lib/InfluxDb.mjs` | Offline exports were silently discarded and buffer checks exceeded their stated limit. At most 2,000 points, including in-flight points, are retained; additional points are rejected and counted. Retries run at the configured interval instead of being triggered by every incoming point during failure. |
| `lib/InfluxDb.mjs` | Ping success could emit `online` despite failed database setup or write authorization. Online status now requires an acknowledged write; repeated rejected writes do not repeatedly emit online/offline transitions. V1 query errors propagate and database query bodies are form-encoded. |
| `lib/InfluxDb.mjs`, `lib/measurementsUtil.mjs` | Backslashes in string fields were not escaped, empty/missing zone tags broke writes, field/tag keys lacked escaping, non-finite numbers could invalidate batches, and epoch zero was discarded. These cases now serialize correctly or are rejected before entering the queue. Comment-like measurement names (`#...`) and trailing identifier backslashes are rejected before they can be ignored or corrupt a batch. Existing measurement/tag naming normalization is retained. |
| `lib/DeviceHandler.mjs` | Device creation was not observed; zone event names were incorrect and their handler referenced nonexistent `this.api`. Listeners now use the installed API's singular event names and supplied zone objects. Subcapabilities use their actual capability keys and available event timestamps. |
| `lib/DeviceHandler.mjs` | Removed capabilities and manager listeners survived re-registration/shutdown. Registration now snapshots capability IDs and destroys old instances; stale asynchronous fetches and startup snapshots cannot resurrect deleted devices or overwrite newer zone events. |
| `lib/Queue.mjs`, `lib/InsightsHandler.mjs` | Queue failures could strand the worker; flushing could start a second worker; disabling metrics left jobs running. Queue ownership now lasts until the active handler settles, delays are cancellable, and destroyed exporters suppress pending results. Scheduled exports do not accumulate behind an active export. |
| `lib/InsightsHandler.mjs` | Insights requests omitted `resolution` and passed unsupported `limit`/`sort` parameters. They now request the selected resolution, handle object-shaped log collections, include zero CPU samples in averages, and exclude missing/non-finite values. |
| `lib/HomeyStateHandler.mjs` | Memory reporting raced the system-info request, reused stale values, rejected zero free memory, and depended on optional app types. Polls now wait for fresh info and cannot overlap. Homey-only metrics include aggregate storage while excluding per-app storage. API timeouts use the installed client's `$timeout` option. |
| `app.mjs`, `locales/en.json` | Transient startup failures previously left the app stopped indefinitely. Initialization retries up to ten attempts with increasing delays, reconnects partially initialized managers, and avoids duplicate registration. Unload stops handlers, API sessions, retries, and startup waits. Flow writes fail visibly when invalid/full/uninitialized; interval validation precedes persistence; settings saves preserve percentage scaling. |
| `settings/index.html` | Readiness waited for settings/status requests and a failed request could strand the settings page. `Homey.ready()` is immediate, initialization failures are caught, and status requests no longer overlap. |
| `package.json`, `test/measurementsUtil_t.js`, `test/stability.mjs` | The Windows-incompatible test command and obsolete module imports were repaired. Regression coverage exercises transport failures, lifecycle races, serialization, subscriptions, metrics, Flow actions, and settings behavior. |
| `.homeycompose/app.json`, generated `app.json` | The selected existing `homey-api@3.20.0` requires Node 22. Minimum firmware is now Homey 12.9.0, matching Athom's Node 22 runtime boundary; older firmware cannot receive an incompatible update. |

## Compatibility and design

- Existing Flow IDs, argument contracts, configuration keys, measurement prefixes/modes, and field names for ordinary capabilities remain unchanged. No capability, device-data, or stored-data migration is introduced.
- Subcapability fields now use the actual capability key; installations previously affected by colliding/missing metadata IDs may see corrected distinct fields.
- `online` / `is_online` now describe acknowledged write access. The reported state is the last checked state; it is not a continuous health monitor when no points are queued.
- `getStatus().influxDb` adds `buffered` and `dropped`; existing status properties remain. `measurements` counts acknowledged points, not unique database rows.
- Insights exports are queued for the normal write interval rather than making independent writes. CPU calculations retain the existing core-normalization formula; the change fixes sample selection, not the platform-specific interpretation of CPU units.
- No dependency versions were changed by this task. Pre-existing changes in `.gitignore`, `.homeyignore`, `package.json` dependencies, and `package-lock.json` were preserved. The task's only package-script change is `test`.
- Compose changes only the minimum firmware from 12.0.1 to 12.9.0; app release version and Flow definitions are unchanged. Older firmware must be upgraded before installing this update. The ESM app/API entrypoint format is unchanged. See [Athom's runtime compatibility table](https://apps.developer.homey.app/the-basics/app).

## Verification evidence

Environment: Windows PowerShell, Node `v24.15.0`; installed `homey-api@3.20.0`, `http.min@2.1.0`, `chai@6.2.2`, `mocha@12.0.0`.

| Command/check | Result |
| --- | --- |
| Initial `npm test` | Failed because `./node_modules/.bin/mocha` is not a Windows command. |
| Initial `node node_modules/mocha/bin/mocha.js --reporter dot` | Failed because the tests required nonexistent `../lib/measurementsUtil`. |
| `node --check` for changed `.mjs`/`.js` sources and tests | Passed. The settings inline script is also parsed/executed by VM tests. |
| `npm test` | 74 passing, including 41 added regression scenarios. |
| `npm audit --omit=dev` | Failed: 7 production findings, detailed below. |
| `homey app validate` | Passed at the CLI's default `publish` level; existing Manager API permission review warning only. |
| Generated output inspection | Manifest changes only minimum firmware; generated ESM entrypoint and relevant modules/settings/locales compared with their source files. |
| `git diff --check`, status and accumulated diff inspection | Used to check whitespace, generated changes, scope, and preservation of the pre-existing edits. |
| Sol reviewer preflight | Passed using Git for Windows `sh.exe` and `/c/...` paths. Initial attempts failed because bare `sh` was unavailable and the shell required POSIX paths; no installation changes were made. |

There is no configured build or lint script, so those were not run. No separate publish-validation command is needed because the installed CLI already validated at `publish`. No runtime/integration/device test was run because those actions were not authorized.

Analysis tools: `rg` / `rg --files`, targeted `Get-Content`, `git rev-parse`, `git status --short`, `git diff`, `git diff --stat` / `--numstat`, `npm ls`, `node --version`, and inspection of installed API implementation/specification files. The call paths reviewed were device/Flow/state/Insights producers → measurement conversion → queue/serializer → HTTP acknowledgement, plus registration, settings, and shutdown callers. No code graph tool was used.

The installed `http.min` implementation resolves promises for HTTP error responses and recognizes the lowercase `content-type` key; both details informed the transport fixes. The installed Homey API confirms manager event payloads, capability callback timestamps, `resolution`, `$timeout`, and session cleanup methods. InfluxDB's [write API documentation](https://docs.influxdata.com/influxdb/v2/api/write/) specifies the acknowledgement/error response contract.

## Remaining risks and dependency findings

- Buffering is in memory, not persistent. A restart discards unsent points. Once the 2,000-point limit is reached, new points are rejected until space becomes available.
- Server-side permanent rejections (for example, existing field-type conflicts or proxy payload limits) retain the batch for retry and require correcting the underlying cause. A server may accept part of a batch before returning an error; retries retain original timestamps, but this is not a transactional/exactly-once guarantee.
- Existing millisecond precision and InfluxDB's same-series/same-timestamp merging behavior remain unchanged.
- Real Homey system-info payloads, CPU units, platform performance, realtime subscriptions, settings UI, and database results need the smoke tests below. Package validation and mocked tests do not prove these behaviors.
- Production audit findings are inherited through `homey-api@3.20.0`: `form-data@4.0.0` (critical), `socket.io-parser@3.3.3` (high), `ws@7.5.10` (high), and `parseuri@0.0.6` plus affected ancestors (four moderate findings). These are production dependencies; exploitability depends on the actual API/network/multipart path. No exploitability test was performed. npm's forced remediation suggests downgrading the user's selected Homey API to `3.14.16`; that dependency migration was not performed.

## Manual runtime smoke tests

Use a test Homey and a disposable database/bucket; these steps have not been executed by Codex.

1. On Homey 12.9.0 or newer with Node 22, install/run the local app using your normal development workflow. Verify startup reaches `InfluxDbApp is running...`, all existing Flow cards remain available, and settings open without browser-console errors.
2. Save the existing v1 credentials/database or v2 organization ID/token/bucket. Trigger the existing number Flow with `0`, boolean Flow with `false`, and text Flow with a quote and trailing backslash. Wait one write interval. Query the test database and verify exact values and timestamps; the acknowledged count should increase only after successful writes.
3. After one successful write, temporarily use an invalid test credential. Generate fewer than 2,000 points. Verify the acknowledged count stops, status becomes offline, only one offline transition occurs, and failures include HTTP status without credentials/measurement bodies. Restore the credential; verify buffered points drain and one online transition follows acknowledgement.
4. Change an existing device capability, add a test device, rename/move its zone, and remove a capability/device. Verify measurements use the current names, zones, and distinct subcapability keys; removed subscriptions stop reporting. Repeat after an app restart and check for duplicate listeners/points.
5. Select Homey-only metrics: verify fresh aggregate memory/storage points, including zero values when applicable, and no new app-only exports. Select all metrics: compare CPU/memory averages with valid samples from the selected last-hour Insights resolution, including idle CPU samples.
6. Disable metrics while an Insights export is pending, then re-enable them repeatedly. Verify old exports stop producing new points, one polling/export loop remains, and memory/CPU use settles.
7. Set the write interval to 10 then 60 seconds and verify cadence changes. Save unrelated settings while percentage scaling is enabled; verify scaling is preserved across the save and restart.
8. If feasible on the test environment, delay/fail a Homey API startup request and then restore it. Verify bounded retries recover without duplicate registration. Stop the app during initialization or an outstanding export/write; confirm stopped components do not restart timers.

Routing: `audit`, primary implementation using the existing model by explicit user authorization, followed by the required fresh Sol reviewer. The final reviewer verdict and observed isolation are recorded in the task response.
