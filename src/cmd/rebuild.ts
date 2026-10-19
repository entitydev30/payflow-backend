/**
 * Rebuild every network's projections from the stored raw events (`events`
 * table), then exit. No RPC calls are made, so this works after history has
 * left the RPC node's retention window — deploy a new projection and run
 * `npm run rebuild` instead of re-indexing from the chain.
 *
 * The cursor and the raw event log are untouched: the next indexer pass picks
 * up where it left off, and the rebuilt projection is what it extends.
 */
import { loadConfig, networkConfigs } from "../config.ts";
import { openDatabase } from "../lib/db.ts";
import { Indexer } from "../indexer.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
let failed = false;

for (const network of networkConfigs(config)) {
  const db = openDatabase(network.databasePath);
  // A rebuild replays stored events through `apply`, which reads no RPC, so
  // the server handle is never touched.
  const indexer = new Indexer(db, {} as never, network);
  try {
    const { events, applied, mismatched } = indexer.rebuild();
    logger.info(
      { network: network.name, events, applied, mismatched },
      "projections rebuilt from stored events",
    );
  } catch (err) {
    failed = true;
    logger.error({ err, network: network.name }, "rebuild failed");
  } finally {
    db.close();
  }
}

if (failed) process.exitCode = 1;
