import { contextBridge, ipcRenderer } from "electron";
import type { RiverBridge } from "../core/bridge";

/**
 * The renderer gets a narrow, explicit API. No fs, no net, no key material
 * except when the user asks for a backup.
 */
const bridge: RiverBridge = {
  snapshot: (includeSilt = false) => ipcRenderer.invoke("river:snapshot", includeSilt),
  publish: (kind, body) => ipcRenderer.invoke("river:publish", kind, body),
  dial: (address) => ipcRenderer.invoke("river:dial", address),
  peers: () => ipcRenderer.invoke("river:peers"),
  verify: () => ipcRenderer.invoke("river:verify"),
  breach: (mode) => ipcRenderer.invoke("river:breach", mode),
  trail: (postId) => ipcRenderer.invoke("river:trail", postId),
  author: (pubkey) => ipcRenderer.invoke("river:author", pubkey),
  identity: () => ipcRenderer.invoke("river:identity"),
  exportKey: () => ipcRenderer.invoke("river:export-key"),
  importKey: (privateKey) => ipcRenderer.invoke("river:import-key", privateKey),
  bootStatus: () => ipcRenderer.invoke("river:boot-status"),
  resetIdentity: () => ipcRenderer.invoke("river:reset-identity"),
  onUpdate: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("river:update", listener);
    return () => {
      ipcRenderer.removeListener("river:update", listener);
    };
  },
  onLog: (handler) => {
    const listener = (_event: unknown, line: string) => handler(line);
    ipcRenderer.on("river:log", listener);
    return () => {
      ipcRenderer.removeListener("river:log", listener);
    };
  },
  openExternal: (url) => {
    void ipcRenderer.invoke("river:open-external", url);
  },
  versions: () => ipcRenderer.invoke("river:versions"),
};

contextBridge.exposeInMainWorld("river", bridge);
