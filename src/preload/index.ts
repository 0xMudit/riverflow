/**
 * The renderer gets a narrow, explicit API. No fs, no net, no key material
 * except when the user asks for a backup.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { RiverBridge } from "../core/bridge";

const bridge: RiverBridge = {
  snapshot: (includeSilt = false) => ipcRenderer.invoke("river:snapshot", includeSilt),
  publish: (kind, body) => ipcRenderer.invoke("river:publish", kind, body),
  publishAs: (kind, body, device) => ipcRenderer.invoke("river:publish-as", kind, body, device),
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
  network: () => ipcRenderer.invoke("river:network"),
  checkpoints: (author) => ipcRenderer.invoke("river:checkpoints", author),
  devices: () => ipcRenderer.invoke("river:devices"),
  authoriseDevice: (device, name) => ipcRenderer.invoke("river:authorise-device", device, name),
  thisDevice: () => ipcRenderer.invoke("river:this-device"),
  authoriseThisDevice: (name) => ipcRenderer.invoke("river:authorise-this-device", name),
  revokeDevice: (device) => ipcRenderer.invoke("river:revoke-device", device),
  attachMedia: (bytes, type, width, height) =>
    ipcRenderer.invoke("river:attach-media", bytes, type, width, height),
  proof: (author, device, seq) => ipcRenderer.invoke("river:proof", author, device, seq),
  draft: (kind, body) => ipcRenderer.invoke("river:draft", kind, body),
  submit: (event) => ipcRenderer.invoke("river:submit", event),
  wallet: () => ipcRenderer.invoke("river:wallet"),
  useWallet: (address) => ipcRenderer.invoke("river:use-wallet", address),
  challenge: () => ipcRenderer.invoke("river:challenge"),
  signIn: (message, signature) => ipcRenderer.invoke("river:sign-in", message, signature),
  mute: (target) => ipcRenderer.invoke("river:mute", target),
  unmute: (target) => ipcRenderer.invoke("river:unmute", target),
  block: (target) => ipcRenderer.invoke("river:block", target),
  unblock: (target) => ipcRenderer.invoke("river:unblock", target),
  addFilter: (word) => ipcRenderer.invoke("river:add-filter", word),
  removeFilter: (word) => ipcRenderer.invoke("river:remove-filter", word),
  moderation: () => ipcRenderer.invoke("river:moderation"),
  markRead: () => ipcRenderer.invoke("river:mark-read"),
  search: (query) => ipcRenderer.invoke("river:search", query),
  thread: (postId) => ipcRenderer.invoke("river:thread", postId),
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
