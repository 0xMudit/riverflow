/**
 * River, from a terminal.
 *
 *   npx tsx src/cli/index.ts post "hello from the command line"
 *   npx tsx src/cli/index.ts feed
 *   npx tsx src/cli/index.ts serve --port 7331
 *
 * Every command is a real node: it opens the same store the desktop app uses,
 * signs with the same key, and speaks the same protocol. One-shot commands
 * (post, react, follow ...) start the node, do the one thing, give gossip a
 * moment to carry it, and stop. `serve` stays online for other people's nodes
 * to find.
 *
 * The renderer is one face of River; this is another. Nothing is mocked here --
 * the CLI cannot do anything the app cannot, and both write to the same log.
 */
import { join, resolve } from "node:path";

import { RiverNode } from "../main/node";
import type { PostView, ProfileView } from "../core/types";
import type { Store } from "../main/store";

// --------------------------------------------------------------------- args

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parse(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

const args = parse(process.argv.slice(2));
const flag = (name: string): string | undefined => args.flags.get(name);
const isSet = (name: string) => args.flags.has(name);

// ------------------------------------------------------------------- output

const ESC = String.fromCharCode(27);
const tty = process.stdout.isTTY === true && !isSet("plain");
const paint = (code: string, text: string) => (tty ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const bold = (text: string) => paint("1", text);
const dim = (text: string) => paint("2", text);
const green = (text: string) => paint("32", text);
const yellow = (text: string) => paint("33", text);
const red = (text: string) => paint("31", text);

function say(...parts: Array<string | number>) {
  console.log(...parts);
}

function fail(message: string): never {
  console.error(red(`x ${message}`));
  process.exit(1);
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const short = (hex: string, size = 8) => hex.slice(0, size);

// -------------------------------------------------------------------- node

/**
 * A CLI node shares the data directory with the desktop app by default, so
 * both are the same person on the network. SQLite's WAL mode lets them hold
 * the file at the same time; only one of them needs to be online to sync.
 */
function dataDir(): string {
  return resolve(flag("dir") ?? join(process.cwd(), "data", flag("name") ?? "cli"));
}

async function openNode(options: { quiet?: boolean } = {}): Promise<RiverNode> {
  const node = new RiverNode({
    dataDir: dataDir(),
    // A one-shot command should not announce itself on the LAN; `serve` opts in.
    port: Number(flag("port") ?? 0),
    discovery: isSet("discovery") || args.command === "serve",
    dht: isSet("dht"),
    log: options.quiet ? undefined : (line) => console.error(dim(`  ${line}`)),
  });
  await node.start();
  // Peers we have met before, then anything passed with --peer.
  const known = node.store.knownPeers().map((peer) => peer.address);
  const wanted = (flag("peer") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const address of [...new Set([...wanted, ...known])].slice(0, 8)) {
    await node.dial(address).catch(() => undefined);
  }
  return node;
}

/** Give gossip a moment to carry the new event outward before we exit. */
async function settle(node: RiverNode) {
  const wait = Number(flag("wait") ?? 1500);
  if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  await node.stop();
}

// ------------------------------------------------------------------- store

/** Posts are addressed by content hash; a prefix is enough to mean one post. */
function resolvePost(store: Store, ref: string): PostView {
  const hex = ref.toLowerCase().replace(/[^0-9a-f]/g, "");
  const rows = store.db
    .prepare("SELECT id FROM posts WHERE id = ? OR id LIKE ? LIMIT 2")
    .all(ref, `${hex}%`) as Array<{ id: string }>;
  const id = rows[0]?.id ?? "";
  if (!id) fail(`no post starts with "${ref}" here`);
  const post = store
    .feed({ includeSilt: true, limit: 200 })
    .top.concat(store.feed({ includeSilt: true, limit: 200 }).replies)
    .find((candidate) => candidate.id === id);
  if (!post) fail(`no post starts with "${ref}" here`);
  return post;
}

function nameOf(profiles: Record<string, ProfileView>, pubkey: string): string {
  return profiles[pubkey]?.name ?? `${short(pubkey)}...`;
}

function printPost(post: PostView, profiles: Record<string, ProfileView>, indent = "") {
  const author = nameOf(profiles, post.author);
  const flags = [
    post.viewerReacted ? yellow(`~${post.reactions}`) : `~${post.reactions}`,
    post.replyCount ? `^${post.replyCount}` : "",
    post.retracted ? red("retracted") : "",
    post.editedAt ? dim("edited") : "",
  ]
    .filter(Boolean)
    .join(" ");
  say(`${indent}${bold(author)} ${dim(`. ${ago(post.createdAt)} . ${short(post.id)}...`)}`);
  for (const line of post.text.split("\n")) say(`${indent}  ${line}`);
  if (post.retractReason) say(`${indent}  ${dim(`reason: ${post.retractReason}`)}`);
  say(`${indent}  ${dim(flags)}`);
  say("");
}

// ---------------------------------------------------------------- commands

const commands: Record<string, (positional: string[]) => Promise<void>> = {
  async help() {
    say(`${bold("river")} - a peer-to-peer social network whose ledger forgets nothing.

  ${bold("river init")}                        create an identity and print it
  ${bold("river id")}                         who this node is
  ${bold("river post")} <text>                write to your log
  ${bold("river reply")} <post> <text>        reply to a post (id or prefix)
  ${bold("river react")} <post> <emoji>       ripple a post
  ${bold("river retract")} <post> [reason]    bury a post under a tombstone
  ${bold("river follow")} <pubkey>            follow somebody
  ${bold("river unfollow")} <pubkey>          stop
  ${bold("river profile")} [--name --bio --hue]  say who you are
  ${bold("river feed")} [--limit N] [--silt]  what you see when you look
  ${bold("river thread")} <post>              one thread, oldest first
  ${bold("river author")} <pubkey>            somebody's posts and profile
  ${bold("river search")} <words>             the words you keep
  ${bold("river log")} [pubkey]               the raw signed events
  ${bold("river inbox")}                      what happened to you
  ${bold("river verify")}                     re-check every signature
  ${bold("river network")}                    peers, DHT, listen address
  ${bold("river serve")} [--port N]           stay online for other nodes

  flags: --dir <path>   data directory (default ./data/cli)
         --peer <addr>  dial this address (host:port), comma-separated
         --wait <ms>    how long a write waits for gossip (default 1500)
         --plain        no colour`);
  },

  async init() {
    const node = await openNode({ quiet: true });
    const me = node.identity.publicKey;
    say(`${bold("identity")}  ${me}`);
    say(`${bold("data dir")}  ${dataDir()}`);
    if (!node.store.profile(me)) {
      say(dim('no profile yet - try: river profile --name yourname'));
    }
    await node.stop();
  },

  async id() {
    const node = await openNode({ quiet: true });
    const me = node.identity.publicKey;
    const profile = node.store.profile(me);
    const stats = node.store.stats();
    say(`${bold("pubkey")}    ${me}`);
    say(`${bold("name")}      ${profile?.name ?? dim("(unnamed)")}`);
    if (profile?.bio) say(`${bold("bio")}       ${profile.bio}`);
    say(`${bold("events")}    ${stats.events} . ${stats.posts} posts . ${stats.following} following`);
    await node.stop();
  },

  async post(positional: string[]) {
    const text = positional.join(" ").trim();
    if (!text) fail('a post needs text: river post "hello"');
    const node = await openNode();
    const event = await node.publish("post", { text });
    say(`${green("ok")} ${dim(short(event.id))}... sealed, signed, gone outward`);
    await settle(node);
  },

  async reply(positional: string[]) {
    const [ref, ...rest] = positional;
    const text = rest.join(" ").trim();
    if (!ref || !text) fail("usage: river reply <post> <text>");
    const node = await openNode();
    const parent = resolvePost(node.store, ref);
    const event = await node.publish("post", { text, replyTo: parent.id });
    say(`${green("ok")} replied to ${dim(short(parent.id))}... as ${dim(short(event.id))}...`);
    await settle(node);
  },

  async react(positional: string[]) {
    const [ref, emoji = "~"] = positional;
    if (!ref) fail("usage: river react <post> [emoji]");
    const node = await openNode();
    const post = resolvePost(node.store, ref);
    await node.publish("reaction", { target: post.id, emoji });
    say(`${green("ok")} rippled ${dim(short(post.id))}... with ${emoji}`);
    await settle(node);
  },

  async retract(positional: string[]) {
    const [ref, ...reason] = positional;
    if (!ref) fail("usage: river retract <post> [reason]");
    const node = await openNode();
    const post = resolvePost(node.store, ref);
    if (post.author !== node.identity.publicKey) fail("you can only retract your own words");
    await node.publish("retract", { target: post.id, reason: reason.join(" ") || undefined });
    say(`${yellow("~")} ${dim(short(post.id))}... is silt now - the log keeps it, the flow hides it`);
    await settle(node);
  },

  async follow(positional: string[]) {
    const [who] = positional;
    if (!who) fail("usage: river follow <pubkey>");
    const node = await openNode();
    await node.publish("follow", { target: who.toLowerCase() });
    node.refreshSubscriptions();
    say(`${green("ok")} following ${short(who)}... - their log is now yours to keep`);
    await settle(node);
  },

  async unfollow(positional: string[]) {
    const [who] = positional;
    if (!who) fail("usage: river unfollow <pubkey>");
    const node = await openNode();
    await node.publish("follow", { target: who.toLowerCase(), unfollow: true });
    node.refreshSubscriptions();
    say(`${green("ok")} unfollowed ${short(who)}...`);
    await settle(node);
  },

  async profile() {
    const node = await openNode();
    const me = node.identity.publicKey;
    const current = node.store.profile(me);
    const body: { name?: string; bio?: string; hue?: number } = {};
    if (isSet("name")) body.name = flag("name");
    if (isSet("bio")) body.bio = flag("bio");
    if (isSet("hue")) body.hue = Number(flag("hue"));
    if (Object.keys(body).length === 0) {
      say(`${bold("name")} ${current?.name ?? dim("(unnamed)")}`);
      if (current?.bio) say(`${bold("bio")}  ${current.bio}`);
      say(dim('change it: river profile --name you --bio "..." --hue 200'));
      await node.stop();
      return;
    }
    if (body.hue !== undefined && !(body.hue >= 0 && body.hue <= 360)) {
      fail("--hue is 0-360");
    }
    await node.publish("profile", {
      ...body,
      name: body.name || current?.name || "anon",
    });
    say(`${green("ok")} profile signed onto your log`);
    await settle(node);
  },

  async feed() {
    const node = await openNode({ quiet: true });
    const limit = Number(flag("limit") ?? 20);
    const page = node.store.feed({
      limit,
      includeSilt: isSet("silt"),
      viewer: node.identity.publicKey,
    });
    const authors = new Set<string>([node.identity.publicKey]);
    for (const post of [...page.top, ...page.replies]) authors.add(post.author);
    const profiles = node.store.profilesFor([...authors]);
    if (page.top.length === 0) say(dim("nothing here yet - post something, or meet a peer"));
    for (const post of page.top) {
      printPost(post, profiles);
      for (const reply of page.replies.filter((candidate) => candidate.root === post.id)) {
        printPost(reply, profiles, "  ");
      }
    }
    await node.stop();
  },

  async thread(positional: string[]) {
    const [ref] = positional;
    if (!ref) fail("usage: river thread <post>");
    const node = await openNode({ quiet: true });
    const view = node.store.thread(resolvePost(node.store, ref).id, {
      viewer: node.identity.publicKey,
      includeSilt: isSet("silt"),
    });
    const profiles = node.store.profilesFor(view.posts.map((post) => post.author));
    for (const post of view.posts) printPost(post, profiles);
    await node.stop();
  },

  async author(positional: string[]) {
    const [who] = positional;
    if (!who) fail("usage: river author <pubkey>");
    const pubkey = who.toLowerCase();
    const node = await openNode({ quiet: true });
    const profile = node.store.profile(pubkey);
    const posts = node.store.postsByAuthor(pubkey, Number(flag("limit") ?? 20));
    say(`${bold(profile?.name ?? `${short(pubkey)}...`)} ${dim(pubkey)}`);
    if (profile?.bio) say(profile.bio);
    say("");
    const profiles = node.store.profilesFor([pubkey]);
    for (const post of posts) printPost(post, profiles);
    await node.stop();
  },

  async search(positional: string[]) {
    const words = positional.join(" ").trim();
    if (!words) fail("usage: river search <words>");
    const node = await openNode({ quiet: true });
    const found = node.store.search(words, {
      viewer: node.identity.publicKey,
      includeSilt: isSet("silt"),
      limit: Number(flag("limit") ?? 20),
    });
    if (found.length === 0) say(dim(`nothing matching "${words}"`));
    const profiles = node.store.profilesFor(found.map((post) => post.author));
    for (const post of found) printPost(post, profiles);
    await node.stop();
  },

  async log(positional: string[]) {
    const node = await openNode({ quiet: true });
    const who = (positional[0] ?? node.identity.publicKey).toLowerCase();
    const events = node.store.eventsFor(who, Number(flag("limit") ?? 30));
    for (const event of events) {
      const body = JSON.stringify(event.body);
      say(
        `${dim(`#${String(event.seq).padStart(4, "0")}`)} ${bold(event.kind.padEnd(8))} ${dim(
          short(event.id),
        )} ${body.length > 90 ? `${body.slice(0, 90)}...` : body}`,
      );
    }
    say(dim(`${events.length} event(s) - every one signed, every one staying`));
    await node.stop();
  },

  async inbox() {
    const node = await openNode({ quiet: true });
    const me = node.identity.publicKey;
    const notes = node.store.notifications(me, Number(flag("limit") ?? 20));
    const profiles = node.store.profilesFor(notes.map((note) => note.actor));
    if (notes.length === 0) say(dim("nothing yet"));
    for (const note of notes) {
      const what =
        note.kind === "reply"
          ? `replied: ${note.text.slice(0, 60)}`
          : note.kind === "reaction"
            ? `rippled ${note.text}`
            : "followed you";
      say(
        `${note.seen ? dim(".") : yellow("o")} ${bold(nameOf(profiles, note.actor))} ${what} ${dim(
          ago(note.createdAt),
        )}`,
      );
    }
    node.store.markNotificationsRead(me);
    await node.stop();
  },

  async verify() {
    const node = await openNode({ quiet: true });
    const report = await node.store.verifyAll();
    if (report.ok) {
      say(
        `${green("ok")} ${report.events} events across ${report.authors} authors - every chain unbroken, every signature covers its content`,
      );
    } else {
      say(`${red("BAD")} ${report.errors.length} problem(s):`);
      for (const error of report.errors) {
        say(`  ${red(error.code)} ${short(error.author)}... #${error.seq} - ${error.detail}`);
      }
    }
    await node.stop();
    if (!report.ok) process.exit(1);
  },

  async network() {
    const node = await openNode({ quiet: true });
    const dht = node.dhtStatus();
    say(`${bold("listen")}   ${node.server.address()}`);
    say(
      `${bold("dht")}      ${dht.joined ? green("joined") : dim("off")}${
        dht.peers !== undefined ? ` . ${dht.peers} peers` : ""
      }`,
    );
    const peers = node.peerViews();
    if (peers.length === 0) {
      say(dim("no peers connected - try --peer host:port, or serve on the same network"));
    }
    for (const peer of peers) {
      say(`${bold(short(peer.id))}... ${peer.direction} ${peer.address} ${dim(ago(peer.since))}`);
    }
    await node.stop();
  },

  async serve() {
    const port = Number(flag("port") ?? 7331);
    const node = new RiverNode({
      dataDir: dataDir(),
      port,
      discovery: true,
      dht: isSet("dht"),
      relay: isSet("relay"),
      log: (line) => console.error(dim(`  ${line}`)),
    });
    await node.start();
    console.error(`${bold("river")} serving on ${port} as ${short(node.identity.publicKey)}... . data ${dataDir()}`);
    console.error(dim("post, react, follow from any terminal pointing at this --dir or --peer"));

    const shutdown = async () => {
      await node.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    await new Promise(() => undefined);
  },
};

// --------------------------------------------------------------------- main

async function main() {
  const command = commands[args.command];
  if (!command) {
    if (args.command !== "version") fail(`unknown command "${args.command}" - try: river help`);
    say("river 0.2");
    return;
  }
  await command(args.positional);
}

main().catch((error) => fail((error as Error).message));
