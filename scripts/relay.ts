/**
 * A headless relay.
 *
 * A relay does one job: hold other people's logs so they survive their author
 * being offline, and hand them to anyone who asks. It holds no key of its own
 * and signs nothing, so there is nothing to seize and nothing to impersonate.
 * Shut it down and the network loses a cache, not a record.
 *
 *   npm run relay                 # port 7331, data in .relay/
 *   RIVER_PORT=7400 npm run relay
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RiverNode } from "../src/main/node";

const port = Number(process.env.RIVER_PORT ?? 7331);
const dataDir = process.env.RIVER_DATA ?? join(process.cwd(), ".relay");
const bootstrap = (process.env.RIVER_DHT_BOOTSTRAP ?? "").split(",").filter(Boolean);
const useDht = process.env.RIVER_DHT !== "0";

const log = (line: string) => console.log(`[relay] ${line}`);

async function main() {
  await mkdir(dataDir, { recursive: true });

  const node = new RiverNode({
    dataDir,
    port,
    discovery: true,
    dht: useDht,
    dhtBootstrap: bootstrap,
    relay: true,
    log,
  });

  await node.start();
  log(`listening on ${node.server.address()}`);
  log(`holding logs for other people · ${node.store.stats().authors} authors`);

  const timer = setInterval(() => {
    const stats = node.store.stats();
    log(`${stats.authors} authors · ${stats.events} events · ${node.peerViews().length} peers`);
  }, 60_000);

  const shutdown = async () => {
    clearInterval(timer);
    await node.stop();
    log("stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
