import { useEffect, useState } from "react";
import type { IdentityInfo, Moderation, ThisDevice, WalletInfo } from "@/core/bridge";
import type { DeviceView, NotificationView, Snapshot } from "@/core/types";
import { plural, shortAddr } from "../format";
import { Copyable } from "../components/Copy";
import { WalletPanel } from "../components/WalletPanel";
import type { PublishFn } from "../useNode";
import type { Eip1193Provider } from "../wallet";

/**
 * You.
 *
 * Everything about the person behind the node lives here: who you are, which
 * keys you write with, and what you have decided not to be shown. The rest of
 * the app stays simple on purpose — a river and the people in it.
 */
export function YouPage({
  snapshot,
  identity,
  wallet,
  thisDevice,
  devices,
  writer,
  onWriter,
  onConnectWallet,
  onDisconnectWallet,
  publish,
  notify,
}: {
  snapshot: Snapshot;
  identity: IdentityInfo;
  wallet: WalletInfo | null;
  thisDevice: ThisDevice | null;
  devices: DeviceView[];
  writer: string;
  onWriter: (device: string) => void;
  onConnectWallet: (provider: Eip1193Provider) => void;
  onDisconnectWallet: () => void;
  publish: PublishFn;
  notify: (message: string) => void;
}) {
  const [moderation, setModeration] = useState<Moderation>({ muted: [], blocked: [], filters: [] });
  const [notifications, setNotifications] = useState<NotificationView[]>(snapshot.notifications);

  const load = () => {
    void window.river
      .moderation()
      .then((list) => setModeration(list))
      .catch(() => undefined);
    void window.river
      .devices()
      .then((list) => setDevices(list))
      .catch(() => undefined);
  };

  const [, setDevices] = useState<DeviceView[]>(devices);

  useEffect(() => {
    load();
  }, [snapshot.me?.seq]);

  const me = snapshot.me;
  const name = me?.name && me.name !== "unnamed" ? me.name : "unnamed";
  const [draftName, setDraftName] = useState(name === "unnamed" ? "" : name);
  const [draftBio, setDraftBio] = useState(me?.bio ?? "");
  const [saving, setSaving] = useState(false);

  const saveProfile = async () => {
    if (!draftName.trim() || saving) return;
    setSaving(true);
    try {
      await publish("profile", {
        name: draftName.trim().slice(0, 32),
        bio: draftBio.trim().slice(0, 160),
        hue: me?.hue ?? 200,
      });
      notify("Saved — and it stays, because it is written into your chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not save that");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header style={{ padding: "20px 0 0" }}>
        <h1 className="serif" style={{ fontSize: 23, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
          You
        </h1>
        <p className="meta" style={{ marginTop: 6 }}>
          {name} · {plural(snapshot.stats.events, "event")} in your chain ·{" "}
          {plural(snapshot.stats.authors, "identity")} known
        </p>
      </header>

      <section className="panel" style={{ marginTop: 18, padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 10 }}>
          Your profile
        </div>
        <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
          <input
            className="input"
            placeholder="your name"
            value={draftName}
            maxLength={32}
            onChange={(event) => setDraftName(event.target.value)}
            aria-label="Your name"
          />
          <input
            className="input"
            placeholder="a line about you (optional)"
            value={draftBio}
            maxLength={160}
            onChange={(event) => setDraftBio(event.target.value)}
            aria-label="Your bio"
          />
          <div>
            <button
              className="btn btn-primary"
              disabled={saving || !draftName.trim()}
              onClick={() => void saveProfile()}
            >
              {saving ? "saving…" : "Save"}
            </button>
          </div>
        </div>
        <p className="meta" style={{ marginTop: 10, lineHeight: 1.6 }}>
          Your name is written into your chain, so it cannot be taken away — and it cannot be
          quietly changed either. Your old name stays where it was.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 18, padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Your key
        </div>
        <p className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-dim)" }}>
          It lives in this machine&apos;s keychain, and it never leaves. Everything you write is
          signed with it, and everything you write stays.
        </p>
        <div style={{ marginTop: 10 }}>
          <Copyable
            value={identity.publicKey}
            label={shortAddr(identity.publicKey)}
            className="mono"
            title={identity.publicKey}
          />
        </div>
        <p className="meta" style={{ marginTop: 10 }}>
          {identity.protected ? "Sealed by the operating system" : "Held in the clear on this machine"}
        </p>
      </section>

      <section className="panel" style={{ marginTop: 14, padding: "14px 16px" }}>
        <WalletPanel
          wallet={wallet}
          onConnect={onConnectWallet}
          onDisconnect={onDisconnectWallet}
          notify={notify}
        />
        <p className="meta" style={{ marginTop: 10, lineHeight: 1.6 }}>
          A wallet is another way to hold the same authority — MetaMask, a hardware box, anything
          that speaks EIP-1193. It is optional; the key above works on its own.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 14, padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Writing as
        </div>
        <p className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-dim)" }}>
          Posts are signed by the key you pick here. A device writes into its own chain, so the
          history of your identity never forks.
        </p>
        <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap" }}>
          <button
            className={writer === "" ? "chip chip-water" : "btn btn-ghost"}
            style={{ fontSize: 11.5 }}
            onClick={() => onWriter("")}
            title="The root key of this identity"
          >
            root key
          </button>
          {devices
            .filter((device) => !device.revoked)
            .map((device) => (
              <button
                key={device.device}
                className={writer === device.device ? "chip chip-water" : "btn btn-ghost"}
                style={{ fontSize: 11.5 }}
                onClick={() => onWriter(device.device)}
                title={device.device}
              >
                {device.name || shortAddr(device.device)}
              </button>
            ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14, padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Devices
        </div>
        <p className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-dim)" }}>
          One identity, many machines. Each keeps its own chain, so a phone and a laptop never
          fork your history — and a machine you no longer trust can be revoked without touching
          the past.
        </p>

        {thisDevice && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 10,
              alignItems: "center",
              padding: "10px 0 0",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5 }}>this machine</div>
              <Copyable
                value={thisDevice.publicKey}
                label={shortAddr(thisDevice.publicKey)}
                className="mono"
                title="the device key this machine holds"
              />
            </div>
            {thisDevice.authorised ? (
              <span className="chip chip-water">may write</span>
            ) : thisDevice.revoked ? (
              <span className="chip chip-silt">revoked</span>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => {
                  void window.river
                    .authoriseThisDevice("this machine")
                    .then(() => notify("This machine may now write on its own chain"))
                    .catch((cause: Error) => notify(cause.message));
                }}
              >
                let it write
              </button>
            )}
          </div>
        )}

        {devices
          .filter((device) => device.device !== thisDevice?.publicKey)
          .map((device) => (
            <div
              key={device.device}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: 10,
                alignItems: "center",
                padding: "10px 0 0",
                borderTop: "1px dotted var(--line)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{device.name || "unnamed device"}</div>
                <Copyable
                  value={device.device}
                  label={shortAddr(device.device)}
                  className="mono"
                  title={device.device}
                />
              </div>
              {device.revoked ? (
                <span className="chip chip-silt">revoked</span>
              ) : (
                <span className="chip chip-water">may write</span>
              )}
              {!device.revoked && (
                <button
                  className="btn btn-danger"
                  style={{ fontSize: 11 }}
                  onClick={() => {
                    void window.river
                      .revokeDevice(device.device)
                      .then(() => {
                        load();
                        notify("Revoked — its past stays, its future stops");
                      })
                      .catch((cause: Error) => notify(cause.message));
                  }}
                >
                  revoke
                </button>
              )}
            </div>
          ))}
      </section>

      <section className="panel" style={{ marginTop: 14, padding: "14px 16px" }}>
        <div className="label" style={{ marginBottom: 8 }}>
          What you do not see
        </div>
        <p className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-dim)" }}>
          Your choices, kept on this machine and sent nowhere. A mute quiets somebody, a block
          removes them from your feed, a filter hides any post containing a word. Nothing is
          deleted anywhere — their history stays on the network.
        </p>

        {moderation.muted.length === 0 &&
          moderation.blocked.length === 0 &&
          moderation.filters.length === 0 && (
            <p className="meta" style={{ fontSize: 11.5, marginTop: 10 }}>
              You have hidden nobody and nothing.
            </p>
          )}

        {moderation.blocked.map((target) => (
          <div
            key={`block-${target}`}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 10,
              alignItems: "center",
              padding: "8px 0 0",
              borderTop: "1px dotted var(--line)",
            }}
          >
            <span className="mono" style={{ fontSize: 11 }}>
              {shortAddr(target)}
            </span>
            <span className="chip chip-silt">blocked</span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => {
                void window.river.unblock(target).then(() => {
                  load();
                  notify("Unblocked — their posts are back");
                });
              }}
            >
              unblock
            </button>
          </div>
        ))}

        {moderation.muted.map((target) => (
          <div
            key={`mute-${target}`}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 10,
              alignItems: "center",
              padding: "8px 0 0",
              borderTop: "1px dotted var(--line)",
            }}
          >
            <span className="mono" style={{ fontSize: 11 }}>
              {shortAddr(target)}
            </span>
            <span className="chip">muted</span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => {
                void window.river.unmute(target).then(() => {
                  load();
                  notify("Unmuted");
                });
              }}
            >
              unmute
            </button>
          </div>
        ))}

        {moderation.filters.map((word) => (
          <div
            key={`filter-${word}`}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 10,
              alignItems: "center",
              padding: "8px 0 0",
              borderTop: "1px dotted var(--line)",
            }}
          >
            <span className="serif" style={{ fontSize: 13 }}>
              “{word}”
            </span>
            <span className="chip">hidden</span>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => {
                void window.river.removeFilter(word).then(() => {
                  load();
                  notify("Filter removed");
                });
              }}
            >
              show again
            </button>
          </div>
        ))}
      </section>

      <section className="panel" style={{ marginTop: 14, padding: "14px 16px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 8,
          }}
        >
          <span className="label">What happened to you</span>
          <span className="meta" style={{ fontSize: 10 }}>
            {notifications.length ? `${notifications.length} recent` : "nothing yet"}
          </span>
        </div>
        {notifications.length === 0 && (
          <p className="meta" style={{ fontSize: 11.5 }}>
            No replies, ripples or follows yet.
          </p>
        )}
        {notifications.slice(0, 10).map((note) => (
          <div
            key={note.id}
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              gap: 10,
              padding: "6px 0",
              borderTop: "1px dotted var(--line)",
              fontSize: 12,
              alignItems: "baseline",
            }}
          >
            <span className="label" style={{ fontSize: 9 }}>
              {note.kind}
            </span>
            <span className="meta">{shortAddr(note.actor)}</span>
            <span className="meta" style={{ fontSize: 10 }}>
              {new Date(note.createdAt).toLocaleDateString()}
            </span>
          </div>
        ))}
        {snapshot.unread > 0 && (
          <button
            className="btn btn-ghost"
            style={{ marginTop: 8, fontSize: 11 }}
            onClick={() => {
              void window.river.markRead().then(() => {
                setNotifications([]);
                notify("Marked read");
              });
            }}
          >
            mark read
          </button>
        )}
      </section>
    </>
  );
}
