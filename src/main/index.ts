import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } from "electron";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { EventBody, EventKind } from "../core/types";
import { importIdentity, type KeyBox } from "./identity";
import { RiverNode } from "./node";

const ALLOWED_KINDS = new Set<EventKind>(["post", "edit", "retract", "reaction", "follow", "profile"]);
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
    return current().publish(kind, body ?? {});
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
