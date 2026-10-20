import type { ProfileView } from "@/core/types";

/** Small formatting helpers shared by the window. */

export function timeAgo(ts: number): string {
  const delta = Date.now() - ts;
  if (!Number.isFinite(delta)) return "—";
  if (delta < 45_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function shortAddr(pubkey: string, head = 6, tail = 4): string {
  if (pubkey.length <= head + tail + 1) return pubkey;
  return `${pubkey.slice(0, head)}…${pubkey.slice(-tail)}`;
}

export function shortHash(hash: string, head = 10, tail = 8): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function initials(name: string): string {
  const cleaned = name.replace(/^anon:/, "#").trim();
  const parts = cleaned.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length === 0) return "#";
  if (parts[0].startsWith("#")) return "#";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function profileOf(profiles: Record<string, ProfileView>, pubkey: string): ProfileView {
  return (
    profiles[pubkey] ?? {
      pubkey,
      name: `anon:${pubkey.slice(0, 6)}`,
      bio: "",
      hue: 200,
      seq: -1,
    }
  );
}

/** Stable hue from a public key; the same person is the same colour everywhere. */
export function hueOf(pubkey: string): number {
  let acc = 0;
  for (let i = 0; i < 8; i++) acc = (acc * 31 + Number.parseInt(pubkey.slice(i * 2, i * 2 + 2), 16)) % 360;
  return acc;
}
