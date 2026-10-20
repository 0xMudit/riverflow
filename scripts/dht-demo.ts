/**
 * Two nodes finding each other across a DHT, with no address typed in.
 *
 * This is the whole point of the transport: a node announces a topic, the DHT
 * tells it who else is listening, and a hole is punched through both
 * firewalls. No server sits in the middle holding anyone's words.
 *
 *   npm run dht
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DHT from "hyperdht";
import { RiverNode, defaultTopic } from "../src/main/node";

const BOOT_PORT = Number(process.env.RIVER_BOOT_PORT ?? 49737);
const BOOT = `127.0.0.1:${BOOT_PORT}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (line: string) => console.log(`[dht] ${line}`);

async function main() {
  // A DHT node of our own, so the demo works with no internet at all.
  const bootstrapper = DHT.bootstrapper(BOOT_PORT, "127.0.0.1");
  await new Promise<void>((resolve) => bootstrapper.on("ready", () => resolve()));
  log(`bootstrap node up at ${BOOT}`);

  const root = await mkdtemp(join(tmpdir(), "river-dht-"));

  const make = async (name: string) => {
    const node = new RiverNode({
      dataDir: join(root, name),
      port: 0,
      discovery: false,
      dht: true,
      dhtBootstrap: [BOOT],
      topic: defaultTopic(),
      log: (line) => log(`${name}: ${line}`),
    });
    await node.start();
    return node;
  };

  const a = await make("a");
  const b = await make("b");

  log("both nodes announced on the topic; waiting for the DHT to introduce them");

  let connected = false;
  for (let attempt = 0; attempt < 40 && !connected; attempt++) {
    await sleep(1000);
    const peers = [...a.peerViews(), ...b.peerViews()];
    connected = peers.length > 0;
    if (connected) {
      log(`peers: ${peers.map((peer) => `${peer.id.slice(0, 8)}@${peer.address}`).join(", ")}`);
    }
  }

  if (!connected) {
    log("✗ the DHT did not introduce the two nodes");
    await a.stop();
    await b.stop();
    await bootstrapper.destroy({ force: true });
    process.exit(1);
  }

  // Now prove the data moves, not just the connection.
  await a.publish("post", { text: "this post found its way across a hole in the NAT" });
  await b.publish("post", { text: "and this one came back the other way" });

  let synced = false;
  for (let attempt = 0; attempt < 30 && !synced; attempt++) {
    await sleep(500);
    synced =
      b.store.postsByAuthor(a.identity.publicKey).length > 0 &&
      a.store.postsByAuthor(b.identity.publicKey).length > 0;
  }

  log(
    synced
      ? `✓ two nodes, no address typed in, one history · a holds ${a.store.stats().events} events, b holds ${b.store.stats().events}`
      : "✗ the nodes connected but the posts did not cross",
  );

  await a.stop();
  await b.stop();
  await bootstrapper.destroy({ force: true });
  process.exit(synced ? 0 : 1);
}

void main();
