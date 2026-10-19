import { DatabaseSync } from "node:sqlite";

/**
 * Schema notes.
 *
 * `plans` and `mandates` are projections rebuilt from contract events, so every
 * write is an idempotent upsert keyed on the on-chain id. Re-indexing the same
 * ledger range twice must not change the result.
 *
 * `charges` is an append-only log keyed on (tx_hash, mandate_id) so a replayed
 * ledger cannot double-count revenue.
 *
 * `mandate_events` is the churn log: one row per mandate per lifecycle event
 * (started, cancelled, ended, completed), stamped with the ledger close time
 * of the event. It is keyed on (mandate_id, slot) and written with
 * INSERT OR IGNORE, so replaying a ledger range cannot record the same
 * event — or the same departure — twice.
 *
 * `events` is the raw event log every projection is built from: one row per
 * contract event the RPC returned, kept verbatim so a new or fixed projection
 * can be rebuilt without re-reading history from RPC (which only retains about
 * a week). The plan is to store topics and data "as JSON", but native JSON
 * cannot round-trip what a Soroban event carries — i128 amounts would have to
 * pass through a JavaScript number and byte buffers have no JSON form — so
 * both columns hold the chain's own XDR encoded as base64 inside a JSON value
 * (an array per topic list, an {"xdr": ...} object for the data map). A
 * rebuild re-decodes those exact bytes, so the projection it produces is
 * bit-identical to the one live indexing produced. Rows are keyed on the RPC
 * event id (its paging token, unique per event) and written with INSERT OR
 * IGNORE, so a replayed or overlapping ledger range stores nothing twice.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY,
  merchant    TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  token       TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  period      INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  ledger      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_merchant ON plans(merchant);

CREATE TABLE IF NOT EXISTS mandates (
  id           INTEGER PRIMARY KEY,
  subscriber   TEXT    NOT NULL,
  merchant     TEXT    NOT NULL,
  plan_id      INTEGER NOT NULL,
  amount       TEXT    NOT NULL,
  period       INTEGER NOT NULL,
  next_charge  INTEGER NOT NULL,
  last_charge  INTEGER NOT NULL DEFAULT 0,
  charges_made INTEGER NOT NULL DEFAULT 0,
  max_charges  INTEGER NOT NULL DEFAULT 0,
  fee_bps      INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'Active',
  -- 'subscriber' or 'merchant' once cancelled; NULL otherwise.
  ended_by     TEXT,
  ledger       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mandates_subscriber ON mandates(subscriber);
CREATE INDEX IF NOT EXISTS mandates_merchant   ON mandates(merchant);
CREATE INDEX IF NOT EXISTS mandates_due        ON mandates(status, next_charge);

CREATE TABLE IF NOT EXISTS charges (
  tx_hash      TEXT    NOT NULL,
  mandate_id   INTEGER NOT NULL,
  subscriber   TEXT    NOT NULL,
  merchant     TEXT    NOT NULL,
  amount       TEXT    NOT NULL,
  fee          TEXT    NOT NULL,
  charges_made INTEGER NOT NULL,
  next_charge  INTEGER NOT NULL,
  ledger       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, mandate_id)
);
CREATE INDEX IF NOT EXISTS charges_merchant   ON charges(merchant);
CREATE INDEX IF NOT EXISTS charges_subscriber ON charges(subscriber);
CREATE INDEX IF NOT EXISTS charges_mandate    ON charges(mandate_id);

CREATE TABLE IF NOT EXISTS vault_events (
  tx_hash      TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  user         TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  counterparty TEXT,
  amount       TEXT    NOT NULL,
  balance      TEXT    NOT NULL,
  ledger       INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, kind, user, amount)
);
CREATE INDEX IF NOT EXISTS vault_events_user ON vault_events(user);
CREATE INDEX IF NOT EXISTS vault_events_user_token_ledger
  ON vault_events(user, token, ledger DESC);
CREATE INDEX IF NOT EXISTS vault_events_user_ledger
  ON vault_events(user, ledger DESC);

CREATE TABLE IF NOT EXISTS fee_history (
  tx_hash      TEXT    PRIMARY KEY,
  old_fee_bps  INTEGER NOT NULL,
  new_fee_bps  INTEGER NOT NULL,
  ledger       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fee_history_ledger ON fee_history(ledger DESC);

-- One row per mandate per lifecycle event, used by the merchant churn
-- endpoint. The "at" column is the ledger close time of the event in unix
-- seconds, so buckets follow the chain's clock rather than the indexer's
-- wall clock.
--
-- The "slot" column is 'start' or 'departure' and is part of the primary key,
-- so a mandate has exactly one start and at most one departure however many
-- times the event is applied. That is what makes the churn report's net
-- figure correct by construction: a mandate can never be counted as leaving
-- twice.
CREATE TABLE IF NOT EXISTS mandate_events (
  mandate_id INTEGER NOT NULL,
  slot       TEXT    NOT NULL,
  merchant   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  ledger     INTEGER NOT NULL,
  PRIMARY KEY (mandate_id, slot)
);
CREATE INDEX IF NOT EXISTS mandate_events_merchant ON mandate_events(merchant, kind, at);

-- Every raw contract event, verbatim, so projections can be rebuilt without
-- RPC history (see the schema notes above). topics is a JSON array of
-- base64 XDR values, data an {"xdr": ...} JSON object; name is topic 0
-- decoded for queries and is NULL when the event does not decode. id is the
-- RPC paging token; tx/op indexes and close_time keep ordering and chain time.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT    PRIMARY KEY,
  type        TEXT    NOT NULL DEFAULT 'contract',
  contract    TEXT    NOT NULL,
  ledger      INTEGER NOT NULL,
  tx_hash     TEXT    NOT NULL,
  tx_index    INTEGER NOT NULL DEFAULT 0,
  op_index    INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  topics      TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  close_time  INTEGER,
  successful  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS events_ledger          ON events(ledger);
CREATE INDEX IF NOT EXISTS events_contract_ledger ON events(contract, ledger);
CREATE INDEX IF NOT EXISTS events_tx_hash         ON events(tx_hash);
`;

/**
 * Columns added after the first deployment. CREATE TABLE IF NOT EXISTS leaves
 * an existing table alone, so new columns have to be added explicitly. Each
 * entry is applied only when absent, which keeps repeated startups a no-op.
 */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, decl: string]> = [
  ["plans", "name", "TEXT NOT NULL DEFAULT ''"],
  ["mandates", "fee_bps", "INTEGER NOT NULL DEFAULT 0"],
  ["mandates", "ended_by", "TEXT"],
];

/**
 * Indexes added after the first deployment. Each is created only when its
 * table exists (a migration may run against a partially built database) and
 * `IF NOT EXISTS` keeps repeated startups a no-op. These are covering indexes
 * for the merchant and subscriber summary routes: the aggregates read only
 * the indexed columns, so the planner never touches the table b-tree.
 */
const ADDED_INDEXES: ReadonlyArray<[table: string, name: string, columns: string]> = [
  ["mandates", "mandates_merchant_status_period_amount", "merchant, status, period, amount"],
  ["charges", "charges_merchant_amount", "merchant, amount"],
  ["charges", "charges_subscriber_amount_fee", "subscriber, amount, fee"],
];

export function migrate(db: DatabaseSync): void {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
      name: string;
    }[];
    // An empty result means the table itself is absent, so there is nothing to
    // migrate -- SCHEMA will have created it with the column already present.
    if (columns.length === 0) continue;
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  for (const [table, name, columns] of ADDED_INDEXES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`);
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function readCursor(db: DatabaseSync, fallback: number): number {
  const row = db.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? fallback;
}

export function writeCursor(db: DatabaseSync, ledger: number): void {
  db.prepare(
    `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
  ).run(ledger);
}

/** One raw contract event as stored in the `events` table. */
export interface StoredEvent {
  /** RPC paging token, unique per event; the idempotency key. */
  id: string;
  /** RPC event type; `contract` for everything the indexer filters for. */
  type: string;
  /** Contract that emitted the event; empty when the RPC did not report one. */
  contract: string;
  ledger: number;
  txHash: string;
  /** Index of the emitting transaction within its ledger. */
  txIndex: number;
  /** Index of the emitting operation within its transaction. */
  opIndex: number;
  /** Topic 0 decoded to a string, or null when it does not decode. */
  name: string | null;
  /** JSON array of base64 XDR values, one entry per topic. */
  topics: string;
  /** JSON object of the form {"xdr": "<base64>"} holding the data section's XDR. */
  data: string;
  /** Ledger close time in unix seconds; null when the RPC did not report one. */
  closeTime: number | null;
  /** Whether the event came from a successful contract call. */
  successful: boolean;
}

/**
 * Store one raw event. INSERT OR IGNORE on the primary key makes this
 * idempotent: a crashed pass that replays its range, or an overlapping range,
 * stores nothing twice.
 */
export function insertEvent(db: DatabaseSync, event: StoredEvent): void {
  db.prepare(
    `INSERT OR IGNORE INTO events
       (id, type, contract, ledger, tx_hash, tx_index, op_index,
        name, topics, data, close_time, successful)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.type,
    event.contract,
    event.ledger,
    event.txHash,
    event.txIndex,
    event.opIndex,
    event.name,
    event.topics,
    event.data,
    event.closeTime,
    event.successful ? 1 : 0,
  );
}

/**
 * Every stored event from `fromLedger` onward, in the order the chain emitted
 * it: ledger, then transaction index, then operation index, then paging token
 * (which encodes the event's position within its operation, zero-padded so it
 * sorts correctly as text). Replaying in this order is what makes a rebuilt
 * projection identical to the one live indexing produced — a `subscribed`
 * always precedes the `charged` events that followed it on-chain.
 */
export function* iterateEvents(
  db: DatabaseSync,
  fromLedger = 0,
): Generator<StoredEvent, void, undefined> {
  const rows = db
    .prepare(
      `SELECT id, type, contract, ledger, tx_hash, tx_index, op_index,
              name, topics, data, close_time, successful
         FROM events
        WHERE ledger >= ?
        ORDER BY ledger, tx_index, op_index, id`,
    )
    .all(fromLedger) as Array<{
    id: string;
    type: string;
    contract: string;
    ledger: number;
    tx_hash: string;
    tx_index: number;
    op_index: number;
    name: string | null;
    topics: string;
    data: string;
    close_time: number | null;
    successful: number;
  }>;
  for (const row of rows) {
    yield {
      id: row.id,
      type: row.type,
      contract: row.contract,
      ledger: row.ledger,
      txHash: row.tx_hash,
      txIndex: row.tx_index,
      opIndex: row.op_index,
      name: row.name,
      topics: row.topics,
      data: row.data,
      closeTime: row.close_time,
      successful: row.successful === 1,
    };
  }
}

/**
 * Empty every projection table, leaving the raw `events` log and the cursor
 * untouched. This is the first half of a rebuild: the projections are then
 * re-derived by replaying `events` through `Indexer.apply`.
 */
export function clearProjections(db: DatabaseSync): void {
  db.exec(
    "DELETE FROM plans; DELETE FROM mandates; DELETE FROM charges; " +
      "DELETE FROM vault_events; DELETE FROM fee_history; DELETE FROM mandate_events;",
  );
}
