"use client";

import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Copyable } from "@/components/Copy";
import { plural, shortAddr } from "@/lib/format";
import { profileOf, type RiverState } from "@/lib/river/project";
import type { Block, EventBody, VerificationReport } from "@/lib/river/types";

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat-cell">
      <div className="mono" style={{ fontSize: 15, color: "var(--ink)", lineHeight: 1.2 }}>
        {value}
      </div>
      <div className="label" style={{ fontSize: 9, marginTop: 3 }}>
        {label}
      </div>
    </div>
  );
}

export function RightRail({
  state,
  report,
  blocks,
  identity,
  submit,
  notify,
}: {
  state: RiverState | null;
  report: VerificationReport | null;
  blocks: Block[];
  identity: { publicKey: string } | null;
  submit: (kind: "follow", body: EventBody) => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const head = blocks[blocks.length - 1];
  const me = identity?.publicKey ?? null;
  const iFollow = me ? new Set(state?.following[me] ?? []) : new Set<string>();

  const suggestions = state
    ? Object.values(state.profiles)
        .filter((profile) => profile.pubkey !== me && !iFollow.has(profile.pubkey))
        .sort((a, b) => (state.followers[b.pubkey]?.length ?? 0) - (state.followers[a.pubkey]?.length ?? 0))
        .slice(0, 4)
    : [];

  const toggleFollow = async (pubkey: string, following: boolean) => {
    try {
      await submit("follow", { target: pubkey, unfollow: following });
      notify(following ? "Unfollowed — the follow stays on the chain" : "Following");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not change follow");
    }
  };

  return (
    <aside className="rail rail-right">
      <section className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "11px 12px",
          }}
        >
          <span className="label">The ledger</span>
          <span className="chip" style={{ borderColor: "transparent", background: "transparent" }}>
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 99,
                background: report?.ok ? "var(--water)" : "var(--danger)",
                boxShadow: report?.ok ? "0 0 7px rgba(91,217,194,0.9)" : "none",
              }}
            />
            {report ? (report.ok ? "intact" : "broken") : "…"}
          </span>
        </div>

        <div className="stat-grid">
          <Stat value={state ? state.stats.blocks : "—"} label="blocks" />
          <Stat value={state ? state.stats.events : "—"} label="events" />
          <Stat value={state ? state.stats.authors : "—"} label="identities" />
          <Stat value={state ? state.stats.retracted : "—"} label="retracted" />
        </div>

        <div style={{ padding: "10px 12px 12px" }}>
          <div className="label" style={{ fontSize: 9, marginBottom: 6 }}>
            head
          </div>
          {head ? (
            <Copyable
              value={head.hash}
              label={head.hash}
              className="mono"
              title={`Block #${head.index} · ${head.events.length} event(s) · nonce ${head.nonce}`}
            />
          ) : (
            <div className="skeleton" style={{ height: 10, width: "100%" }} />
          )}
          <div className="meta" style={{ marginTop: 9, lineHeight: 1.5 }}>
            {report
              ? `${plural(report.events, "signature")} checked in this browser · ${plural(
                  blocks.length,
                  "block",
                )}`
              : "verifying…"}
          </div>
          <Link
            href="/chain"
            className="btn"
            style={{ width: "100%", marginTop: 10, fontSize: 12 }}
          >
            Open the ledger
          </Link>
        </div>
      </section>

      {suggestions.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <div className="label" style={{ marginBottom: 10 }}>
            Currents
          </div>
          <div style={{ display: "grid", gap: 11 }}>
            {suggestions.map((profile) => {
              const followers = state?.followers[profile.pubkey]?.length ?? 0;
              return (
                <div key={profile.pubkey} style={{ display: "flex", gap: 9, alignItems: "center" }}>
                  <Avatar name={profile.name} hue={profile.hue} size={26} title={profile.pubkey} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="name" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {profile.name}
                    </div>
                    <div className="meta" style={{ fontSize: 10 }}>
                      {followers ? plural(followers, "follower") : shortAddr(profile.pubkey)}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 11, padding: "3px 6px" }}
                    onClick={() => void toggleFollow(profile.pubkey, false)}
                  >
                    follow
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section style={{ marginTop: 26 }}>
        <div className="label" style={{ marginBottom: 8 }}>
          What this is
        </div>
        <p
          className="serif"
          style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--ink-dim)" }}
        >
          Every post, reply, edit and retraction is a signed event sealed into a block. Nothing is
          ever removed — a retraction is itself a block, laid on top of the words it hides.
        </p>
        <p className="meta" style={{ marginTop: 10, lineHeight: 1.6 }}>
          Your key is your account. It never leaves this browser.
        </p>
      </section>
    </aside>
  );
}
