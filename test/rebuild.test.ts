import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { openDatabase, readCursor, writeCursor } from "../src/lib/db.ts";
import { Indexer, type IndexerRpc } from "../src/indexer.ts";
import type { NetworkConfig } from "../src/config.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** Chain time of ledger L, as the RPC reports it. */
const BASE_TIME = 1_700_000_000;
function closeTimeOf(ledger: number): string {
  return new Date((BASE_TIME + ledger * 5) * 1000).toISOString();
}

/** The indexer reads the network it was constructed with. Never hits the network. */
function net(): NetworkConfig {
  return {
    name: "testnet",
    rpcUrl: "https://rpc.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    planRegistryId: CONTRACT,
    vaultId: CONTRACT,
    subscriptionId: CONTRACT,
    startLedger: 0,
    databasePath: ":memory:",
  };
}

let opCounter = 0;
/** A raw RPC event shaped like the real getEvents response, paging token included. */
function rawEvent(
  ledger: number,
  name: string,
  topics: xdr.ScVal[],
  value: xdr.ScVal,
): rpc.Api.EventResponse {
  opCounter += 1;
  return {
    id: `${String(ledger).padStart(10, "0")}-${String(opCounter).padStart(10, "0")}`,
    type: "contract",
    contractId: CONTRACT,
    ledger,
    ledgerClosedAt: closeTimeOf(ledger),
    transactionIndex: 0,
    operationIndex: opCounter,
    inSuccessfulContractCall: true,
    txHash: `tx-${opCounter}`,
    topic: [nativeToScVal(name, { type: "symbol" }), ...topics],
    value,
  } as unknown as rpc.Api.EventResponse;
}

const address = (value: string) => nativeToScVal(value, { type: "address" });
const u64 = (value: bigint | number) => nativeToScVal(value, { type: "u64" });

/** Every event kind the indexer knows, plus one it does not and one that mismatches. */
function eventLog(): rpc.Api.EventResponse[] {
  return [
    rawEvent(100, "plan_created", [address(MERCHANT), u64(1n)], nativeToScVal(
      { token: CONTRACT, amount: 10_000_000n, period: 2_592_000n, name: "Pro Monthly" },
      {
        type: {
          token: ["symbol", "address"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          name: ["symbol", "string"],
        },
      },
    )),
    rawEvent(101, "subscribed", [u64(1n), address(SUBSCRIBER), address(MERCHANT)], nativeToScVal(
      {
        plan_id: 1n,
        amount: 10_000_000n,
        period: 2_592_000n,
        next_charge: BigInt(BASE_TIME + 101_000),
        max_charges: 0,
        fee_bps: 100,
      },
      {
        type: {
          plan_id: ["symbol", "u64"],
          amount: ["symbol", "i128"],
          period: ["symbol", "u64"],
          next_charge: ["symbol", "u64"],
          max_charges: ["symbol", "u32"],
          fee_bps: ["symbol", "u32"],
        },
      },
    )),
    rawEvent(102, "charged", [u64(1n), address(SUBSCRIBER), address(MERCHANT)], nativeToScVal(
      { amount: 9_900_000n, fee: 100_000n, charges_made: 1, next_charge: BigInt(BASE_TIME + 200_000) },
      {
        type: {
          amount: ["symbol", "i128"],
          fee: ["symbol", "i128"],
          charges_made: ["symbol", "u32"],
          next_charge: ["symbol", "u64"],
        },
      },
    )),
    rawEvent(103, "charged", [u64(1n), address(SUBSCRIBER), address(MERCHANT)], nativeToScVal(
      { amount: 9_900_000n, fee: 100_000n, charges_made: 2, next_charge: BigInt(BASE_TIME + 300_000) },
      {
        type: {
          amount: ["symbol", "i128"],
          fee: ["symbol", "i128"],
          charges_made: ["symbol", "u32"],
          next_charge: ["symbol", "u64"],
        },
      },
    )),
    rawEvent(104, "cancelled", [u64(1n), address(SUBSCRIBER)], nativeToScVal(
      { charges_made: 2 },
      { type: { charges_made: ["symbol", "u32"] } },
    )),
    rawEvent(105, "fee_changed", [address(MERCHANT)], nativeToScVal(
      { old_fee_bps: 100, new_fee_bps: 125 },
      { type: { old_fee_bps: ["symbol", "u32"], new_fee_bps: ["symbol", "u32"] } },
    )),
    rawEvent(106, "deposit", [address(SUBSCRIBER), address(CONTRACT)], nativeToScVal(
      { amount: 500n, balance: 5_000n },
      { type: { amount: ["symbol", "i128"], balance: ["symbol", "i128"] } },
    )),
    // A brand-new contract event the spec does not cover: not projected, but stored.
    rawEvent(107, "upgraded", [address(MERCHANT)], nativeToScVal(
      { version: 2n },
      { type: { version: ["symbol", "u64"] } },
    )),
    // A spec mismatch (unexpected data field): reported, not projected, but stored.
    rawEvent(108, "charged", [u64(1n), address(SUBSCRIBER), address(MERCHANT)], nativeToScVal(
      { amount: 9_900_000n, fee: 100_000n, charges_made: 3, next_charge: BigInt(BASE_TIME + 400_000), tip: 5n },
      {
        type: {
          amount: ["symbol", "i128"],
          fee: ["symbol", "i128"],
          charges_made: ["symbol", "u32"],
          next_charge: ["symbol", "u64"],
          tip: ["symbol", "i128"],
        },
      },
    )),
  ];
}

/** An RPC node holding `events`, as in test/sync.test.ts. Range and cursor reads only. */
function fakeRpc(events: rpc.Api.EventResponse[]): IndexerRpc {
  return {
    getLatestLedger: async () => ({ sequence: 110, closeTime: closeTimeOf(110) }) as never,
    getHealth: async () => ({ oldestLedger: 90, latestLedger: 110 }) as never,
    getEvents: async (req: Record<string, unknown>) => {
      let pool: rpc.Api.EventResponse[];
      if (req.cursor !== undefined) {
        pool = events.slice(Number(req.cursor));
      } else {
        const start = req.startLedger as number;
        const end = (req.endLedger as number | undefined) ?? Infinity;
        pool = events.filter((e) => e.ledger >= start && e.ledger < end);
      }
      const page = pool.slice(0, Math.min(200, req.limit as number));
      const offset = events.indexOf(page[page.length - 1]!) + 1;
      return { events: page, cursor: String(offset), latestLedger: 110 } as never;
    },
  } as unknown as IndexerRpc;
}

/** Every projection table's full contents, comparable with deepEqual. */
function snapshot(db: ReturnType<typeof openDatabase>): Record<string, unknown[]> {
  const tables = [
    "plans",
    "mandates",
    "charges",
    "vault_events",
    "fee_history",
    "mandate_events",
  ];
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    // Table names are a fixed list above; no request data is involved.
    out[table] = (db.prepare("SELECT * FROM " + table).all() as Record<string, unknown>[]).map(
      (row) => ({ ...row }),
    );
  }
  return out;
}

function eventCount(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

describe("raw event log", () => {
  test("tick stores every fetched event, including ones the projection skips", async () => {
    const db = openDatabase(":memory:");
    const indexer = new Indexer(db, fakeRpc(eventLog()), net());

    await indexer.catchUp();

    // Nine events fetched, nine stored -- the unknown and the spec-mismatched
    // ones included, which are exactly the events a future projection needs.
    assert.equal(eventCount(db), 9);
    const names = (db.prepare("SELECT name FROM events ORDER BY ledger").all() as {
      name: string | null;
    }[]).map((row) => row.name);
    assert.deepEqual(names, [
      "plan_created",
      "subscribed",
      "charged",
      "charged",
      "cancelled",
      "fee_changed",
      "deposit",
      "upgraded",
      "charged",
    ]);
    // Only the events the projection understands reached the projection tables.
    assert.equal(indexer.mismatchedEvents, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM charges").get() as { n: number }).n, 2);
    db.close();
  });

  test("replaying a range stores nothing twice and changes no projection", async () => {
    const db = openDatabase(":memory:");
    const indexer = new Indexer(db, fakeRpc(eventLog()), net());
    await indexer.catchUp();
    const before = snapshot(db);

    // Rewind the cursor and re-read the same range, as a crashed pass would.
    writeCursor(db, 90);
    await indexer.tick();

    assert.equal(eventCount(db), 9);
    assert.deepEqual(snapshot(db), before);
    db.close();
  });

  test("events without a paging token get a stable derived id", async () => {
    // Hand-built events (tests, fixtures) carry no RPC paging token; two
    // distinct events in the same transaction still need distinct rows.
    const noToken = (ledger: number, planId: number): rpc.Api.EventResponse =>
      ({
        ledger,
        txHash: "tx-shared",
        topic: [
          nativeToScVal("plan_created", { type: "symbol" }),
          address(MERCHANT),
          u64(BigInt(planId)),
        ],
        value: nativeToScVal(
          { token: CONTRACT, amount: 1n, period: 60n, name: `p${planId}` },
          {
            type: {
              token: ["symbol", "address"],
              amount: ["symbol", "i128"],
              period: ["symbol", "u64"],
              name: ["symbol", "string"],
            },
          },
        ),
      }) as unknown as rpc.Api.EventResponse;
    const db = openDatabase(":memory:");
    const indexer = new Indexer(db, fakeRpc([noToken(100, 10), noToken(100, 11)]), net());

    await indexer.catchUp();
    assert.equal(eventCount(db), 2);

    // A replay derives the same ids, so it inserts nothing new.
    writeCursor(db, 90);
    await indexer.tick();
    assert.equal(eventCount(db), 2);
    db.close();
  });
});

describe("rebuild from stored events", () => {
  test("rebuild produces identical projections (issue #34 acceptance)", async () => {
    const db = openDatabase(":memory:");
    const indexer = new Indexer(db, fakeRpc(eventLog()), net());
    await indexer.catchUp();
    const before = snapshot(db);
    const cursorBefore = readCursor(db, 0);
    const storedBefore = eventCount(db);

    // Corrupt every projection table, so a rebuild that merely no-ops fails.
    db.prepare("UPDATE plans SET amount = '1', name = ''").run();
    db.prepare("DELETE FROM charges").run();
    db.prepare("UPDATE mandates SET status = 'Bogus', charges_made = 99").run();
    db.prepare("DELETE FROM mandate_events").run();
    db.prepare("DELETE FROM fee_history").run();
    db.prepare("DELETE FROM vault_events").run();

    const result = indexer.rebuild();

    assert.deepEqual(snapshot(db), before);
    assert.equal(result.events, storedBefore);
    assert.equal(result.applied, 8, "seven projected plus the unknown one");
    assert.equal(result.mismatched, 1, "the spec mismatch is reported again");
    // The raw log and the cursor are what the next pass extends; neither moves.
    assert.equal(eventCount(db), storedBefore);
    assert.equal(readCursor(db, 0), cursorBefore);
    db.close();
  });

  test("rebuilding twice in a row is stable", async () => {
    const db = openDatabase(":memory:");
    const indexer = new Indexer(db, fakeRpc(eventLog()), net());
    await indexer.catchUp();

    indexer.rebuild();
    const once = snapshot(db);
    indexer.rebuild();

    assert.deepEqual(snapshot(db), once);
    db.close();
  });
});
