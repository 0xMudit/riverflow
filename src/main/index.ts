import { app, BrowserWindow, ipcMain, Menu, protocol, safeStorage, shell } from "electron";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { Event, EventBody, EventKind } from "../core/types";
import { importIdentity, type KeyBox } from "./identity";
import { defaultTopic, RiverNode } from "./node";

/**
 * The window shows media through `river://blob/<hash>`. The bytes come out of
 * the sealed store, decrypted, and never touch the disk in the clear.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "river",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const ALLOWED_KINDS = new Set<EventKind>([
  "post",
  "edit",
  "retract",
  "reaction",
  "follow",
  "profile",
  "device",
]);
const isDev = !app.isPackaged;

let window: BrowserWindow | null = null;
let node: RiverNode | null = null;
let ready: Promise<void> = Promise.resolve();
let flush: NodeJS.Timeout | null = null;
let bootFailure: string | null = null;
let identityLocked = false;

function keyBox(): KeyBox | null {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        seal: (plain) => safeStorage.encryptString(plain),
        unseal: (sealed) => safeStorage.decryptString(sealed),
      };
    }
  } catch {
    /* fall through to plaintext */
  }
  return null;
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#070a0b",
    title: "River",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function boot() {
  const dataDir = app.getPath("userData");
  const box = keyBox();
  const log = (line: string) => {
    console.log(`[river] ${line}`);
    window?.webContents.send("river:log", line);
  };

  const make = (port: number) =>
    new RiverNode({
      dataDir,
      port,
      discoveryPort: 7332,
      peers: (process.env.RIVER_PEERS ?? "").split(",").filter(Boolean),
      // The DHT is how a node finds peers across NATs. It is on by default and
      // can be pointed at any bootstrap node, including one you run yourself.
      dht: process.env.RIVER_DHT !== "0",
      dhtBootstrap: (process.env.RIVER_DHT_BOOTSTRAP ?? "").split(",").filter(Boolean),
      // A relay holds other people's logs so they survive an offline author.
      relay: process.env.RIVER_RELAY === "1",
      topic: defaultTopic(),
      box,
      log,
    });

  node = make(7331);
  try {
    await node.start();
  } catch (error) {
    // A port clash is worth retrying. A key that will not open is not: the same
    // failure would happen on any port, and the message must reach the user.
    if (!node.identity) throw error;
    log(`port 7331 unavailable (${(error as Error).message}); using an ephemeral port`);
    await node.stop().catch(() => undefined);
    node = make(0);
    await node.start();
  }

  node.on("update", () => {
    if (flush) return;
    flush = setTimeout(() => {
      flush = null;
      window?.webContents.send("river:update");
    }, 120);
  });
}

/**
 * Media is served from the sealed store over a private scheme. The renderer
 * never sees a file path and never gets bytes it did not ask for.
 */
function registerProtocol() {
  protocol.handle("river", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "blob") return new Response("not found", { status: 404 });
      const hash = url.pathname.replace(/^\//, "");
      const blob = node?.store.getBlob(hash);
      if (!blob) return new Response("not found", { status: 404 });
      return new Response(blob.bytes, {
        headers: {
          "content-type": blob.ref.type || "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function registerIpc() {
  const current = () => {
    if (node?.identity) return node;
    throw new Error(bootFailure ?? "the local node is still starting");
  };

  ipcMain.handle("river:snapshot", async (_event, includeSilt: boolean) => {
    await ready;
    return current().snapshot(Boolean(includeSilt));
  });

  ipcMain.handle("river:publish", async (_event, kind: EventKind, body: EventBody) => {
    await ready;
    if (!ALLOWED_KINDS.has(kind)) throw new Error(`unknown event kind: ${kind}`);
    const running = current();
    const event = await running.publish(kind, body ?? {});
    running.refreshSubscriptions();
    return event;
  });

  ipcMain.handle("river:publish-as", async (_event, kind: EventKind, body: EventBody, device: string) => {
    await ready;
    if (!ALLOWED_KINDS.has(kind)) throw new Error(`unknown event kind: ${kind}`);
    if (!device) throw new Error("no device named");
    return current().publish(kind, body ?? {}, device);
  });

  ipcMain.handle("river:dial", async (_event, address: string) => {
    await ready;
    if (typeof address !== "string" || !/^[\w.\-]+:\d{1,5}$/.test(address.trim())) {
      return { ok: false, error: "expected an address like 192.168.1.20:7331" };
    }
    try {
      await current().dial(address.trim());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle("river:peers", async () => {
    await ready;
    return current().peerViews();
  });

  ipcMain.handle("river:verify", async () => {
    await ready;
    return current().verify();
  });

  ipcMain.handle("river:breach", async (_event, mode: "erase" | "rewrite") => {
    await ready;
    const running = current();
    return running.store.simulateBreach(running.identity.publicKey, mode === "rewrite" ? "rewrite" : "erase");
  });

  ipcMain.handle("river:trail", async (_event, postId: string) => {
    await ready;
    if (typeof postId !== "string") return [];
    return current().store.trailFor(postId);
  });

  ipcMain.handle("river:author", async (_event, pubkey: string) => {
    await ready;
    const running = current();
    return {
      profile: running.store.profile(pubkey),
      posts: running.store.postsByAuthor(pubkey),
      events: running.store.eventsFor(pubkey, 200),
    };
  });

  ipcMain.handle("river:identity", async () => {
    await ready;
    const running = current();
    return {
      publicKey: running.identity.publicKey,
      path: running.identity.path,
      protected: running.identity.protected,
    };
  });

  ipcMain.handle("river:export-key", async () => {
    await ready;
    // Deliberate, user-initiated: this is the one path the key leaves the node.
    return current().identity.privateKey;
  });

  ipcMain.handle("river:import-key", async (_event, privateKey: string) => {
    await ready;
    const dir = app.getPath("userData");
    await importIdentity(dir, String(privateKey ?? ""), keyBox());
    // A different key means a different log; restart rather than pretend.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
    return { publicKey: "", path: dir, protected: false };
  });

  ipcMain.handle("river:boot-status", async () => {
    await ready;
    return { ok: Boolean(node?.identity), error: bootFailure, identityLocked };
  });

  ipcMain.handle("river:reset-identity", async () => {
    // Non-destructive: the old key file is renamed, never deleted, and the
    // events it signed stay in the ledger and on the network.
    const file = join(app.getPath("userData"), "identity.bin");
    try {
      await rename(file, `${file}.locked-${Date.now()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
  });

  ipcMain.handle("river:network", async () => {
    await ready;
    const running = current();
    return {
      listen: running.server.address(),
      dht: running.dhtStatus(),
      relay: process.env.RIVER_RELAY === "1",
      peers: running.peerViews(),
      subscriptions: running.store.subscriptions(),
      wanted: running.store.wanted().length,
    };
  });

  ipcMain.handle("river:checkpoints", async (_event, author?: string) => {
    await ready;
    const running = current();
    if (author) return running.store.checkpointsFor(author);
    const mine = running.store.checkpointsFor(running.identity.publicKey);
    return mine;
  });

  ipcMain.handle("river:devices", async () => {
    await ready;
    return current().devices();
  });

  ipcMain.handle("river:authorise-device", async (_event, device: string, name: string) => {
    await ready;
    if (!/^[0-9a-f]{64}$/i.test(String(device ?? ""))) {
      throw new Error("expected a 64-character device key");
    }
    return current().authoriseDevice(String(device).toLowerCase(), String(name ?? ""));
  });

  ipcMain.handle("river:this-device", async () => {
    await ready;
    const running = current();
    const devices = running.devices();
    const mine = devices.find((entry) => entry.device === running.device.publicKey);
    return {
      publicKey: running.device.publicKey,
      name: mine?.name ?? "",
      authorised: mine ? !mine.revoked : false,
      revoked: Boolean(mine?.revoked),
    };
  });

  ipcMain.handle("river:authorise-this-device", async (_event, name: string) => {
    await ready;
    return current().authoriseThisDevice(String(name ?? "this machine"));
  });

  ipcMain.handle("river:revoke-device", async (_event, device: string) => {
    await ready;
    if (!/^[0-9a-f]{64}$/i.test(String(device ?? ""))) {
      throw new Error("expected a 64-character device key");
    }
    return current().revokeDevice(String(device).toLowerCase());
  });

  ipcMain.handle("river:attach-media", async (_event, bytes: Uint8Array, type: string, width?: number, height?: number) => {
    await ready;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return current().attachMedia(data, String(type ?? ""), {
      ...(typeof width === "number" ? { width } : {}),
      ...(typeof height === "number" ? { height } : {}),
    });
  });

  ipcMain.handle("river:proof", async (_event, author: string, device: string, seq: number) => {
    await ready;
    return current().store.proofFor(String(author ?? ""), String(device ?? ""), Number(seq));
  });

  ipcMain.handle("river:draft", async (_event, kind: EventKind, body: EventBody) => {
    await ready;
    if (!ALLOWED_KINDS.has(kind)) throw new Error(`unknown event kind: ${kind}`);
    return current().draftEvent(kind, body ?? {});
  });

  ipcMain.handle("river:submit", async (_event, event: Event) => {
    await ready;
    return current().submitEvent(event);
  });

  ipcMain.handle("river:wallet", async () => {
    await ready;
    return current().walletInfo();
  });

  ipcMain.handle("river:use-wallet", async (_event, address: string | null) => {
    await ready;
    if (address && !/^0x[0-9a-f]{40}$/i.test(String(address))) {
      throw new Error("expected an address like 0x1234…");
    }
    current().setWallet(address ? String(address).toLowerCase() : null);
  });

  ipcMain.handle("river:challenge", async () => {
    await ready;
    return current().createChallenge();
  });

  ipcMain.handle("river:sign-in", async (_event, message: string, signature: string) => {
    await ready;
    return current().verifySignIn(String(message ?? ""), String(signature ?? ""));
  });

  ipcMain.handle("river:mute", async (_event, target: string) => {
    await ready;
    current().store.mute(String(target ?? ""));
  });

  ipcMain.handle("river:unmute", async (_event, target: string) => {
    await ready;
    current().store.unmute(String(target ?? ""));
  });

  ipcMain.handle("river:mark-read", async () => {
    await ready;
    const running = current();
    running.store.markNotificationsRead(running.identity.publicKey);
  });

  ipcMain.handle("river:search", async (_event, query: string) => {
    await ready;
    const running = current();
    return running.store.search(String(query ?? ""), { viewer: running.identity.publicKey });
  });

  ipcMain.handle("river:thread", async (_event, postId: string) => {
    await ready;
    const running = current();
    return running.store.thread(String(postId ?? ""), { viewer: running.identity.publicKey });
  });

  ipcMain.handle("river:versions", async () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));

  ipcMain.handle("river:open-external", async (_event, url: string) => {
    if (typeof url === "string" && url.startsWith("https://")) await shell.openExternal(url);
  });
}

const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerIpc();
    registerProtocol();
    createWindow();
    ready = boot().catch((error) => {
      bootFailure = (error as Error).message;
      identityLocked = (error as { code?: string }).code === "IDENTITY_LOCKED";
      console.error("[river] failed to start", error);
      window?.webContents.send("river:log", `failed to start: ${bootFailure}`);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    void node?.stop();
  });
}
