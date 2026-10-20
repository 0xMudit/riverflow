/**
 * A bootstrap node for the DHT.
 *
 * The DHT needs somebody to introduce peers to each other. That somebody is
 * just a node: it holds no posts, serves no accounts, and can be replaced by
 * any other node at any time. Run one if the public ones are unreachable, or
 * if you would rather the network you use not depend on anyone's server.
 *
 *   npm run bootstrap                 # 127.0.0.1:49737
 *   RIVER_BOOT_PORT=49737 npm run bootstrap
 */
import DHT from "hyperdht";

const port = Number(process.env.RIVER_BOOT_PORT ?? 49737);
const host = process.env.RIVER_BOOT_HOST ?? "0.0.0.0";

const node = DHT.bootstrapper(port, host);

node.on("listening", () => {
  console.log(`[bootstrap] dht node listening on ${host}:${port}`);
});
node.on("ready", () => {
  console.log("[bootstrap] ready — point other nodes at this with RIVER_DHT_BOOTSTRAP");
});
node.on("error", (error: Error) => {
  console.error(`[bootstrap] ${error.message}`);
});

const shutdown = async () => {
  await node.destroy({ force: true });
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
