<h1 align="center">Payflow â€” Backend</h1>

<p align="center">
  <strong>Event indexer, settlement keeper, and read API for the Payflow protocol.</strong>
</p>

<p align="center">
  <a href="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/MMM-pay/payflow-backend/actions/workflows/ci.yml/badge.svg"/>
  </a>
  <img alt="Node" src="https://img.shields.io/badge/node-22-green"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.9-blue"/>
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-green"/>
</p>

> **Live demo:** https://mmm-pay.github.io/payflow-frontend/ Â·
> **Docs:** https://mmm-pay.github.io/payflow-docs/ ·
> **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
> **Runbook:** [docs/RUNBOOK.md](docs/RUNBOOK.md)

---

## What this does

Soroban contracts can answer "what is the state of mandate 7?" but they cannot
answer "show me every mandate this merchant has, sorted by revenue." That is
what this service is for. It does three jobs:

| Component | Job |
|---|---|
| **Indexer** | Polls Soroban RPC for contract events and projects them into SQLite |
| **Keeper** | Finds mandates that have fallen due and calls `charge` on-chain |
| **API** | Serves the projection to the frontend over REST |

### The keeper is not a trust dependency

`charge` is permissionless on-chain. This keeper holds no user funds and has no
privileged role â€” it only pays the transaction fee to trigger settlement. If it
stops running, merchants and subscribers can settle their own mandates directly.
Nothing is lost but timeliness.

### Indexing is idempotent by construction

The ledger cursor advances only after a batch is applied, so a crash mid-batch
replays that range on restart. Every write is designed for that:

- `plans` and `mandates` are upserts keyed on the on-chain id.
- `charges` is keyed on `(tx_hash, mandate_id)`, so a replayed ledger cannot
  double-count revenue.
- Mandate updates are guarded by `WHERE charges_made < ?`, so an out-of-order
  event can never move a mandate backwards.
- Every raw contract event is also stored verbatim in the `events` table,
  keyed on the RPC event id and written with `INSERT OR IGNORE` — a replayed
  or overlapping range stores nothing twice. The log outlives the RPC node's
  ~7-day retention window, so projections can be rebuilt from it at any time
  (`npm run rebuild`), including after a new or fixed projection ships.

## Quick start

```bash
npm install
cp .env.example .env      # already points at the deployed testnet contracts
npm test                  # 149 tests, no network needed
npm run dev
```

Index until caught up with the network, then exit (cron, backfills):

```bash
npm run indexer
```

Rebuild every projection from the stored raw events (`events` table) with no
RPC calls — what you run after deploying a new projection, or once history has
left the RPC node's retention window:

```bash
npm run rebuild
```

Run one settlement pass and exit (needs `KEEPER_SECRET`):

```bash
npm run keeper
```

### How the loops behave

- **No overlapping passes.** Each loop schedules its next pass only after the
  current one finishes, so a slow backfill cannot race itself on the cursor
  and the keeper cannot submit two transactions with the same sequence number.
- **Where indexing starts.** The saved cursor; with none, `INDEXER_START_LEDGER`
  (the ledger the contracts were deployed at); with neither, the oldest ledger
  the RPC node still serves. A cursor older than the node's retention window is
  moved forward with a warning, since RPC rejects ranges that start before it.
- **Exact ranges.** Each pass reads `[cursor, cursor + 8000)` windows and
  never a ledger the RPC node is still closing. Up to
  `INDEXER_FETCH_CONCURRENCY` windows are fetched at once, but they are
  applied in ledger order and the cursor advances only after a window is
  applied. Paging continues until a page is empty or passes the range end: a
  short page does not mean the range is exhausted.
- **Failing mandates back off.** A mandate whose charge fails (usually an
  empty vault) is retried after 1 minute, then 2, 4 and so on up to 6 hours. A
  success clears it. Without this, 25 underfunded mandates at the front of the
  queue would block every other mandate.
- **Events are validated against the contract spec.** Every decoded event is
  checked against `src/lib/event_spec.json` before it is projected. A renamed
  or retyped contract field makes the event fail validation: it is logged with
  the exact problems, counted in `/health`'s `indexer.mismatchedEvents`, and
  never silently stored as zeros. Update the spec file together with the
  contracts. Either way the raw event is stored in the `events` table first,
  so a fixed spec can re-derive the projection with `npm run rebuild` without
  re-reading history from RPC.

### Reconciling the projection with the chain

Idempotent indexing repairs replays, but it cannot repair a missed event: an
RPC gap or a bug can leave the projection wrong forever. Every
`RECONCILE_INTERVAL_MS` the reconciler samples `RECONCILE_SAMPLE_SIZE` active
mandates from the projection, re-reads each one from the subscription
contract through a read-only `get_mandate` simulation, and compares `status`,
`charges_made` and `next_charge`. Anything that differs is rewritten in place,
keyed on the mandate id, so re-running the pass is a no-op once the row
matches the chain. A failed RPC read is logged and retried on the next pass;
it never crashes the loop. Corrections are logged and reported on `/health`
under `indexer.reconciliations` and `indexer.corrections`.

### Rotating the keeper key without downtime

`charge` is permissionless, so the keeper key is only a fee payer â€” but losing
it used to mean an outage until someone edited the config and restarted. It no
longer does:

1. Fund a new testnet account and set `KEEPER_SECRET_NEXT` to its `S...` key.
   The keeper keeps signing with `KEEPER_SECRET`.
2. If the primary key becomes unusable (unfunded, deleted, or compromised and
   drained), the keeper switches to the standby key and retries the same
   mandate within the same pass. Once a pass settles with the new key, the log
   line `keeper settled with the rotated key; the previous key can now be
   retired` names both public keys.
3. Promote the standby: make it `KEEPER_SECRET`, drop `KEEPER_SECRET_NEXT`,
   and send the process `SIGHUP` (`kill -HUP <pid>`). Node re-reads `.env`,
   the config is re-validated and the running keeper swaps its signing keys â€”
   no restart, and the next successful pass confirms the old key can be
   retired. A leaked key can be abandoned mid-pass the same way; nothing is
   lost but a few seconds of timeliness.

Secrets are never logged; rotation logs only public keys.

### Settling in parallel with channel accounts

A single account can only have one transaction in flight — the next `charge`
has to wait for the previous one's sequence number — so one key settles a few
charges per minute and large merchants get billed hours late. List extra
signing accounts in `KEEPER_CHANNEL_SECRETS` (comma-separated `S...` keys) and
one pass distributes the due mandates across them:

- Each channel signs and sequences **its own** transactions and pays its own
  fees, so sequence numbers live on separate accounts and cannot collide.
  Channel keys need only XLM for fees: `charge` is permissionless, so no
  channel key holds user funds or any on-chain authority.
- Due mandates are pulled from one shared queue by one worker per channel —
  strictly one transaction at a time *within* a channel, several channels in
  parallel. With a single channel the pass is exactly the old sequential
  behaviour, and `KEEPER_SECRET` is always the first channel.
- Before distributing, each channel's account is checked with one `getAccount`.
  A channel that cannot pay (unfunded, deleted) is skipped for the pass —
  logged by public key — and its share settles through the live channels
  instead of backing off against a dead key. `KEEPER_SECRET_NEXT` rotation
  still applies to the primary channel, before and during the pass.

A fee-bump design (main key pays every fee) was deliberately rejected: a
Stellar fee-bump consumes the *fee source's* sequence number, so every
transaction would sequence against the one main account and serialize again.

## API

Base path `/api`. All amounts are strings in the token's smallest unit
(stroops for XLM) to avoid JavaScript float precision loss.

`/health` is a **liveness** probe and always answers 200, so a slow backfill
does not get the service restarted. `/ready` is a **readiness** probe: it
answers 503 (`starting` until the indexer's first pass, then `catching_up`)
while the projection trails the network by more than 120 ledgers, and 200
`ready` once it is within that threshold. Point orchestration readiness
checks at `/ready` and liveness checks at `/health`.

When extra networks are configured (see below), every route also answers under
`/api/<network>/...` — `/api/mainnet/plans`, `/api/testnet/stats` — while
`/api/...` keeps serving the default network unchanged.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | Status (`starting`, `ok`, `catching_up`), indexer cursor, lag, `paused` state, data freshness (`freshnessSeconds`), spec-mismatch count, contract IDs, active RPC endpoint |
| `GET` | `/ready` | Readiness probe: `200 ready` once caught up, `503` (`starting`/`catching_up`) while behind |
| `GET` | `/api/plans?merchant=&limit=` | Published plans |
| `GET` | `/api/plans/:id` | One plan |
| `GET` | `/api/plans/:id/stats` | Per-plan statistics: active and total mandates, cancellations, total collected, average charges per mandate |
| `GET` | `/api/mandates?ids=&subscriber=&merchant=&status=` | Mandates |
| `GET` | `/api/mandates/:id` | One mandate |
| `GET` | `/api/mandates/:id/charges` | Settlement history |
| `GET` | `/api/stream?merchant=&subscriber=` | Server-sent `charged`, `subscribed`, `cancelled` and `mandate_ended` events (25-second heartbeat) |
| `GET` | `/api/vault/:address` | Latest balance per token |
| `GET` | `/api/vault/:address/events?limit=` | Vault deposit, withdrawal and debit history, newest first |
| `GET` | `/api/protocol` | Current protocol fee (`fee_bps`) and fee-change history |
| `GET` | `/api/keeper` | Last 20 keeper passes, failures and mandate backoff (only when enabled) |
| `GET` | `/api/due` | Mandates chargeable right now |
| `GET` | `/api/merchants/:address/summary` | Active mandates, revenue, MRR and ARR |
| `GET` | `/api/merchants/:address/subscribers?limit=` | The merchant's distinct subscribers, grouped by lifetime value |
| `GET` | `/api/merchants/:address/churn?bucket=month&limit=` | Per-bucket churn: mandates started, cancelled, ended and completed, and the net |
| `GET` | `/api/merchants/:address/forecast?days=30` | Projected charges over the next N days, net of fees |
| `GET` | `/api/subscribers/:address/summary` | Mandates and total paid |
| `GET` | `/api/subscribers/:address/upcoming?days=30` | Charges due over the next N days, with projected times |
| `GET` | `/api/stats` | Protocol totals, charge volume, fees and last indexed ledger |

`/api/mandates` also accepts `ids`, a comma-separated batch of up to 100
mandate ids (`?ids=1,2,3`). Ids that do not exist are omitted; more than 100
ids returns `400` with `error.code = "too_many_ids"` and a non-numeric id
returns `400` with `error.code = "invalid_ids"`.

### Merchant churn

`GET /api/merchants/:address/churn` reports how a merchant's mandate base
moved over time: how many mandates started, how many departed (cancelled by
the subscriber, ended by the merchant, or completed their full charge count),
and the net of the two.

```json
{
  "merchant": "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH",
  "bucket": "month",
  "buckets": [
    {
      "bucket": "2025-01",
      "started": 3,
      "cancelled": 1,
      "ended": 0,
      "completed": 2,
      "net": 0
    }
  ],
  "totals": { "started": 3, "cancelled": 1, "ended": 0, "completed": 2, "net": 0 }
}
```

- `bucket` picks the period: `day`, `week` or `month` (the default). Buckets
  are calendar periods in UTC — a month bucket is labelled `2025-01`, a day
  bucket `2025-01-15`, and a week bucket carries the Monday's date.
- `limit` caps how many of the most recent buckets are reported (12 by
  default, 120 at most). Every bucket in the range is present, so a chart has
  no gaps in it.
- `net` is `started` minus the departures, i.e. the growth of the mandate
  base in that bucket.

The counts are bucketed by the **ledger close time** of each event, so they
describe the chain's own history rather than when the indexer happened to
index it. Replaying a ledger range therefore leaves the report unchanged.

### Error responses

Every non-2xx response uses one structured envelope, so a client can branch on
a stable `code` and show the human-readable `message` without parsing prose:

```json
{
  "error": {
    "code": "plan_not_found",
    "message": "No plan exists with that id.",
    "requestId": "b1e4..."
  }
}
```

- `code` is machine-readable and stable per condition (the closed set below);
  new variants are added, never renamed.
- `message` is safe to display. It never carries an exception string, a bound
  SQL value, or an RPC URL — `internal_error` always uses fixed copy.
- `requestId` echoes the response's `X-Request-Id` header so a report can be
  tied to the matching server log line. It is `null` only if no id was minted.

> **Migration note.** This envelope replaces the earlier `{ "error": "<code>" }`
> string body. Consumers that read the error must now read `error.code`.

| `error.code` | HTTP | Where |
|---|---|---|
| `not_found` | 404 | An unknown path, or a method/path the API does not expose |
| `plan_not_found` | 404 | `GET /api/plans/:id` or `GET /api/plans/:id/stats` with no such plan |
| `mandate_not_found` | 404 | `GET /api/mandates/:id` with no such mandate |
| `invalid_ids` | 400 | `?ids=` contains a non-positive-integer token |
| `too_many_ids` | 400 | `?ids=` lists more than 100 ids |
| `invalid_token_id` | 400 | `GET /api/tokens/:id` with a malformed contract id |
| `token_metadata_unavailable` | 502 | `GET /api/tokens/:id` while the token contract cannot be read |
| `rate_limited` | 429 | API request exceeded the configured per-IP limit; includes `Retry-After` |
| `stream_limit` | 503 | `GET /api/stream` when the concurrent stream cap is reached |
| `unauthorized` | 401 | A `/admin/*` request without a valid bearer token |
| `reindex_unavailable` | 503 | `POST /admin/reindex` on a process without an indexer |
| `indexer_unavailable` | 503 | `/admin/indexer/pause`/`resume` on a process without an indexer |
| `keeper_unavailable` | 503 | A keeper endpoint while `KEEPER_ENABLED=false` |
| `reindex_failed` | 500 | `POST /admin/reindex` threw (operator message retained) |
| `keeper_pass_failed` | 500 | `POST /admin/keeper/run` threw (operator message retained) |
| `internal_error` | 500 | Any unhandled failure at the API boundary |

Example:

```bash
curl localhost:8080/api/merchants/GB343X.../summary
{
  "merchant": "GB343X...",
  "activeMandates": 1,
  "totalCollected": "19800000",
  "chargeCount": 2,
  "arr": "5256000000000",
  "tokens": [
    { "token": "CDLZFC...", "totalCollected": "19800000", "mrr": "432000000000" }
  ]
}
```

`mrr` and `arr` normalise every active mandate's own period to a 30-day month
(2,592,000 s) and a 365-day year (31,536,000 s) respectively:

```
mrr = sum(amount Ã— 2592000 / period)   over active mandates
arr = sum(amount Ã— 31536000 / period)  over active mandates
```

A yearly plan of 120,000000 stroops therefore reports `arr` of 120000000 and
an `mrr` of 9863013. A short-period demo plan produces a very large figure;
that is arithmetic, not a bug.

### Golden response fixtures

`test/golden.test.ts` captures every route's JSON for a seeded in-memory
database and compares it against a checked-in snapshot in `test/fixtures/`.
Because the comparison is a full deep-equal, a renamed field, a dropped field,
or a changed value fails the test even when the targeted assertions still pass
— this is what stops a response shape drifting silently out from under the
frontend.

The capture is deterministic by construction: the clock is frozen for the whole
run, the indexer status is fixed, and a fixed `x-request-id` header is echoed
into every error envelope. No test touches the network.

Update the snapshots **intentionally** when a response change is meant to land:

```bash
UPDATE_GOLDEN=1 npm test         # rewrites test/fixtures/*.json from the API
git diff test/fixtures           # review it like any other contract change
```

A snapshot should only move because you asked it to; an unexpected diff is the
regression the fixture exists to catch.

### Typed API client

Response shapes are declared once, in `src/routes/types.ts`. The route
handlers annotate their bodies with those types, one router per resource
lives in `src/routes/*.ts`, and the client in `src/client/index.ts`
re-exports the same declarations â€” types are shared, not copied, so backend
and frontend cannot drift.

```ts
import { PayflowClient, PayflowApiError } from "payflow-backend/client";

const api = new PayflowClient("http://localhost:8080");
const { plans } = await api.plans({ merchant });
const summary = await api.merchantSummary(merchant); // MerchantSummary, typed
try {
  await api.plan(999);
} catch (err) {
  if (err instanceof PayflowApiError && err.status === 404) { /* ... */ }
}
```

Every endpoint is covered: `health`, `plans`, `plan`, `mandates`, `mandate`,
`charges`, `due`, `merchantSummary`, `subscriberSummary`, `stats`. The
package is private for now: the frontend depends on it from the repository
(it is built by `npm run build` into `dist/client`), and publishing it to a
registry is a release-time step for maintainers.

`tokens` breaks the same revenue down per token, joined through each charge's
mandate and plan. With `TOKEN_ID` configured, the flat `totalCollected` and
`mrr` cover that default token only, so a merchant's other tokens cannot
inflate them; without one they keep their previous all-token meaning.
`chargeCount` always counts every token's charges.

`upcoming` projects each active mandate's charges over the next `days`
(default 30, capped at 365). A mandate already due is projected at `now` — the
keeper settles it on its next pass — and then every `period`; a future one
starts at its `next_charge`. Missed periods are not replayed, matching the
contract, which sets `next_charge = charge time + period` rather than walking
the ones it skipped. A `max_charges` cap limits the count to the remaining
allowance, charges are listed oldest-first inside `[now, until)`, `amount` is
the gross per-charge the subscriber pays, and `truncated` marks output clipped
by the per-mandate cap of 400 occurrences.

`forecast` sums the charges active mandates will produce in the next `days`
(default 30, capped at 365), each occurrence net of the mandate's `fee_bps`.
Occurrence times are `next_charge + k × period`; a `max_charges` of 0 means no
expiry, otherwise the remaining allowance caps the count. The response carries
its `assumptions` (window bounds, fee normalisation, vault funding ignored)
so consumers do not have to infer them.

### Operator endpoints

`/admin/*` exists only when `ADMIN_TOKEN` is set, and every request needs
`Authorization: Bearer <token>`, compared in constant time. Without the
variable the paths are absent and 404 like any other unknown route.

| Method | Path | Action |
|---|---|---|
| `POST` | `/admin/reindex` | Run one indexer pass now |
| `POST` | `/admin/indexer/pause` | Hold the indexer loop back without stopping the API |
| `POST` | `/admin/indexer/resume` | Let indexer passes run again |
| `POST` | `/admin/keeper/run` | Run one settlement pass now |
| `GET` | `/admin/keeper/backoff` | Mandates backing off after failed charges |

Triggered passes share one serialized runner with the scheduled loops, so a
trigger queues behind a pass that is still running instead of overlapping it —
overlap would race the cursor and, for the keeper, the account sequence
number. The keeper endpoints answer `503 keeper_unavailable` when the keeper
is off (`KEEPER_ENABLED=false`). A pass that fails answers 500 and the failure
is logged; the next scheduled pass retries as usual.

Pausing the indexer makes each scheduled pass a no-op: no RPC reads, no
writes, and the saved cursor is preserved, so resuming continues exactly where
it left off. The API keeps serving the projection as it stands throughout, and
`/health` reports `indexer.paused: true` while held back. This is the runtime
investigation switch — it does not stop the process, so a bad event can be
examined without API downtime.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC endpoint, or a comma-separated list to fail over between |
| `NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network id |
| `PLAN_REGISTRY_ID` | — | Deployed registry contract |
| `VAULT_ID` | — | Deployed vault contract |
| `SUBSCRIPTION_ID` | — | Deployed subscription contract |
| `TOKEN_ID` | — | Default token for the flat merchant-summary amounts. Unset, they span every token |
| `NETWORKS` | *(empty)* | Extra networks to serve, comma-separated (see below) |
| `KEEPER_ENABLED` | `false` | Turn on automatic settlement |
| `KEEPER_SECRET` | — | `S...` key that pays settlement fees. Required when the keeper is on |
| `KEEPER_SECRET_NEXT` | — | Standby `S...` key for zero-downtime rotation; see [Rotating the keeper key](#rotating-the-keeper-key-without-downtime) |
| `KEEPER_CHANNEL_SECRETS` | *(empty)* | Extra `S...` channel keys, comma-separated: each settles in parallel with its own sequence and fees; see [Settling in parallel with channel accounts](#settling-in-parallel-with-channel-accounts) |
| `KEEPER_INTERVAL_MS` | `60000` | Settlement poll interval |
| `KEEPER_ORDER` | `oldest` | Order for due mandates: `oldest` (due date ascending) or `largest` (amount descending) |
| `KEEPER_FEE_PERCENTILE` | `90` | Soroban inclusion-fee percentile used for charge transactions (`50`, `60`, `70`, `80`, `90`, `95`, or `99`) |
| `KEEPER_MAX_FEE` | `100000` | Maximum inclusion fee in stroops; congestion retries cannot exceed this cap |
| `INDEXER_INTERVAL_MS` | `10000` | Indexing poll interval |
| `INDEXER_FETCH_CONCURRENCY` | `4` | Ledger windows one pass may fetch at once (max 16). Applied in order; `1` is sequential |
| `INDEXER_START_LEDGER` | `0` | Where to start with no saved cursor. `0` starts from the oldest ledger RPC still serves |
| `RECONCILE_INTERVAL_MS` | `600000` | How often the reconciler re-checks a sample of active mandates against the contract state, in ms |
| `RECONCILE_SAMPLE_SIZE` | `25` | Active mandates sampled per reconcile pass; each sample costs one read-only RPC simulation |
| `DATABASE_PATH` | `./payflow.db` | SQLite file |
| `PORT` | `8080` | HTTP port |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | Per-IP API rate-limit window in milliseconds |
| `API_RATE_LIMIT_MAX` | `120` | Maximum requests per IP in each API rate-limit window |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP collector base URL. Unset disables tracing at no cost |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | How long shutdown waits for in-flight passes |
| `ADMIN_TOKEN` | — | Bearer token for `/admin`. Unset keeps those routes disabled |

Setting `OTEL_EXPORTER_OTLP_ENDPOINT` exports OpenTelemetry spans for every
RPC call (`rpc.<method>`), indexer and keeper pass, and HTTP request. Every
response carries an `X-Request-Id` (a caller-supplied id is reused), which also
appears in the request logs. Secrets such as `KEEPER_SECRET` are redacted from
logs.

To try tracing locally, start any OTLP/HTTP collector (for example the
Jaeger all-in-one image, which accepts OTLP on port 4318) and run:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
```

Spans are batched and sent to `<endpoint>/v1/traces` every few seconds and on
shutdown. Without the variable, tracing does nothing and costs nothing.

The keeper is **off** by default. Turning it on requires funding
`KEEPER_SECRET` with XLM for transaction fees.

`SOROBAN_RPC_URL` may list several endpoints. Calls go to the active endpoint
(reported under `rpc.active` on `/health`). If a call fails, the next endpoint
is tried and takes over, so an outage at one provider does not stop indexing
or settlement; the caller's loop logs the failure and retries next pass. A
lagging endpoint — one that answers but from an older ledger — loses to the
freshest endpoint the health probe finds. Reads get a 15-second timeout, so a
hung provider fails over instead of stalling a pass forever.

### Serving testnet and mainnet from one instance

Everything above describes the default network. To serve additional networks
beside it, list them in `NETWORKS` and configure each one with `<NAME>_`
prefixed variables:

```bash
NETWORKS=mainnet
MAINNET_SOROBAN_RPC_URL=https://mainnet.sorobanrpc.example
MAINNET_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
MAINNET_PLAN_REGISTRY_ID=C...
MAINNET_VAULT_ID=C...
MAINNET_SUBSCRIPTION_ID=C...
MAINNET_INDEXER_START_LEDGER=5110418
```

Each network runs its own indexer with its own cursor and its own SQLite
database — derived from `DATABASE_PATH` (`./payflow.db` becomes
`./payflow-mainnet.db`) unless `<NAME>_DATABASE_PATH` says otherwise — so
ledger numbers, replay windows and outages on one network never affect the
other. Unprefixed `/api/...` routes always serve the default network
(`STELLAR_NETWORK`); everything is also reachable under `/api/<name>/...`. The
keeper settles the default network only.


## Deployment

**API.** `render.yaml` is a Render blueprint for the free plan: Node 22 and
`/health` as the health check. The free plan has no disk, so the SQLite
projection is rebuilt from `INDEXER_START_LEDGER` after each restart, which
takes seconds while the deployment ledger is within RPC retention (about 7
days on testnet). On a paid plan, add a disk and point `DATABASE_PATH` at it.

**Keeper.** [`.github/workflows/keeper.yml`](.github/workflows/keeper.yml)
settles due testnet mandates roughly every 15 minutes from GitHub Actions,
using the `KEEPER_SECRET` repository secret, and caches its projection between
runs. A free web service sleeps when idle, so it is not a reliable place for
the keeper. The key only pays fees: if the workflow stops, anyone can still
call `charge`.

**Fly.io.** [`fly.toml`](fly.toml) deploys the container image with a 1 GB
volume mounted at `/data` for the SQLite file, so the projection survives
restarts, plus `/health` checks and small-instance autostop. From a checkout:

```bash
fly auth login
fly apps create payflow-backend        # pick another name if taken, then update fly.toml
fly volumes create payflow_data --region sjc --size 1
fly secrets set KEEPER_SECRET=S...     # optional; only to settle due mandates
fly deploy
curl https://payflow-backend.fly.dev/health
```

`fly.toml` ships with the deployed testnet contract IDs and
`DATABASE_PATH=/data/payflow.db`; override either with
`fly secrets set`. The image's entrypoint runs the app as a non-root user and
takes ownership of the data directory, which a fresh root-owned volume
requires.

**Container image.** [`Dockerfile`](Dockerfile) builds a multi-stage image
(`npm ci && npm run build`, then production dependencies only) that serves the
API and runs the indexer loop on `node dist/index.js` as a non-root user.
Pushing a `v*` tag publishes `ghcr.io/mmm-pay/payflow-backend:<version>` via
[`.github/workflows/release.yml`](.github/workflows/release.yml):

```bash
docker run --env-file .env -v payflow_data:/data ghcr.io/mmm-pay/payflow-backend:0.2.0
```

## Related repositories

| Repo | Role |
|---|---|
| [payflow-contract](https://github.com/MMM-pay/payflow-contract) | Soroban contracts this service indexes |
| [payflow-backend](https://github.com/MMM-pay/payflow-backend) | This repo |
| [payflow-frontend](https://github.com/MMM-pay/payflow-frontend) | Consumes this API |
| [payflow-docs](https://github.com/MMM-pay/payflow-docs) | Protocol documentation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `lint`, `typecheck`, `test`,
`build` and a production `audit`; all five must pass, and Dependabot keeps
dependencies current. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Security

See [SECURITY.md](SECURITY.md). Unaudited, testnet only.

## Maintainers

| Name | Role | Contact |
|---|---|---|
| Victor Adeleke | Lead maintainer | [@titilope12](https://github.com/titilope12) |

## Contributors

<a href="https://github.com/MMM-pay/payflow-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MMM-pay/payflow-backend"/>
</a>

## License

Apache-2.0.
