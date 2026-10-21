import { useEffect, useState } from "react";
import type { BootStatus, IdentityInfo, ThisDevice, WalletInfo } from "@/core/bridge";
import type { DeviceView, EventBody, EventKind } from "@/core/types";
import { LeftRail } from "./components/LeftRail";
import { RightRail } from "./components/RightRail";
import { Toast } from "./components/Toast";
import { NetworkPage } from "./pages/Network";
import { ProfilePage } from "./pages/Profile";
import { RiverPage } from "./pages/River";
import { useNode } from "./useNode";
import { useToast } from "./useToast";
import { connect, signBytes, signText, type Eip1193Provider } from "./wallet";

export type View =
  | { name: "river" }
  | { name: "network" }
  | { name: "profile"; pubkey: string };

export default function App() {
  const [includeSilt, setIncludeSilt] = useState(false);
  const [view, setView] = useState<View>({ name: "river" });
  const { snapshot, identity, error, boot, refresh, publish } = useNode(includeSilt);
  const { message, notify } = useToast();

  const [thisDevice, setThisDevice] = useState<ThisDevice | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  /** the key this machine writes with: "" is the root key */
  const [writer, setWriter] = useState("");
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.river
        .thisDevice()
        .then((device) => alive && setThisDevice(device))
        .catch(() => undefined);
      void window.river
        .devices()
        .then((list) => alive && setDevices(list))
        .catch(() => undefined);
      void window.river
        .wallet()
        .then((info) => alive && setWallet(info))
        .catch(() => undefined);
    };
    load();
    return () => {
      alive = false;
    };
  }, [snapshot?.me?.seq]);

  /**
   * Seal an event.
   *
   * With a wallet connected, the node prepares the event and the wallet signs
   * it: the key is in the wallet, so the window asks and the node checks.
   * Without one, the node signs it itself, and the key never leaves the node.
   */
  const sealed = async (kind: EventKind, body: EventBody, device = "") => {
    if (provider && wallet?.signedIn && !device) {
      const draft = await window.river.draft(kind, body);
      const signature = await signBytes(provider, draft.author, draft.digest);
      const event = await window.river.submit({
        id: draft.id,
        author: draft.author,
        scheme: draft.scheme,
        seq: draft.seq,
        prev: draft.prev,
        kind: draft.kind,
        body: draft.body,
        createdAt: draft.createdAt,
        // Wallets write 0x in front of a signature; the log keeps plain hex.
        sig: signature.startsWith("0x") ? signature.slice(2) : signature,
      });
      notify(`Sealed · event ${event.seq} in your chain`);
      return event;
    }
    const event = await publish(kind, body, device || undefined);
    notify(`Sealed · event ${event.seq} in your chain`);
    return event;
  };

  /** Connect a wallet, then prove it holds the key. */
  const connectWallet = async (chosen: Eip1193Provider) => {
    try {
      const address = await connect(chosen);
      await window.river.useWallet(address);
      setProvider(chosen);

      // Sign in: a statement the wallet signs once, with a nonce that cannot
      // be replayed.
      const challenge = await window.river.challenge();
      const signature = await signText(chosen, address, challenge.message);
      const ok = await window.river.signIn(challenge.message, signature);
      const info = await window.river.wallet();
      setWallet(info);
      notify(ok ? `Signed in with ${address.slice(0, 10)}…` : "the wallet could not be verified");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "the wallet did not answer");
    }
  };

  const disconnectWallet = async () => {
    await window.river.useWallet(null);
    setProvider(null);
    setWallet(null);
  };

  const openIdentity = identity as IdentityInfo | null;

  if (!snapshot || !openIdentity) {
    return <Boot error={error} boot={boot} />;
  }

  return (
    <>
      <div className="shell">
        <LeftRail
          snapshot={snapshot}
          identity={openIdentity}
          view={view}
          onNavigate={setView}
          publish={sealed}
          notify={notify}
          thisDevice={thisDevice}
          devices={devices}
          writer={writer}
          onWriter={setWriter}
          wallet={wallet}
          onConnectWallet={(chosen) => void connectWallet(chosen)}
          onDisconnectWallet={() => void disconnectWallet()}
        />

        <main className="feed-col">
          <div className="current" />

          {error && (
            <div
              style={{
                margin: "14px 0 0",
                fontSize: 12,
                color: "var(--danger)",
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <span>{error}</span>
              <button className="btn btn-ghost" onClick={() => void refresh()}>
                retry
              </button>
            </div>
          )}

          {view.name === "river" && (
            <RiverPage
              snapshot={snapshot}
              me={openIdentity.publicKey}
              includeSilt={includeSilt}
              onToggleSilt={() => setIncludeSilt((value) => !value)}
              publish={sealed}
              notify={notify}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
              onOpenNetwork={() => setView({ name: "network" })}
              writer={writer}
            />
          )}

          {view.name === "network" && (
            <NetworkPage
              snapshot={snapshot}
              identity={openIdentity}
              notify={notify}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
              thisDevice={thisDevice}
              devices={devices}
            />
          )}

          {view.name === "profile" && (
            <ProfilePage
              pubkey={view.pubkey}
              snapshot={snapshot}
              me={openIdentity.publicKey}
              publish={sealed}
              notify={notify}
              onBack={() => setView({ name: "river" })}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
            />
          )}
        </main>

        <RightRail snapshot={snapshot} onNavigate={setView} publish={sealed} notify={notify} />
      </div>

      <Toast message={message} />
    </>
  );
}

function Boot({ error, boot }: { error: string | null; boot: BootStatus | null }) {
  const [resetting, setResetting] = useState(false);

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div className="wordmark" style={{ fontSize: 30 }}>
          River<em>.</em>
        </div>
        <p className="meta" style={{ marginTop: 12, lineHeight: 1.7 }}>
          {error ?? "starting your node, opening the ledger…"}
        </p>

        {boot?.identityLocked ? (
          <>
            <button
              className="btn btn-primary"
              style={{ marginTop: 18 }}
              disabled={resetting}
              onClick={() => {
                setResetting(true);
                void window.river.resetIdentity();
              }}
            >
              {resetting ? "restarting…" : "start a new identity"}
            </button>
            <p className="meta" style={{ marginTop: 14, fontSize: 11, lineHeight: 1.6 }}>
              The unreadable key file is renamed, not deleted. Anything it signed stays in the
              ledger and on the network — but this machine can no longer write as it.
            </p>
          </>
        ) : (
          <div
            className="skeleton"
            style={{ height: 2, marginTop: 22, width: 220, marginInline: "auto" }}
          />
        )}
      </div>
    </div>
  );
}
