import { useEffect, useState } from "react";
import type { BootStatus, IdentityInfo, ThisDevice, WalletInfo } from "@/core/bridge";
import type { DeviceView, EventBody, EventKind, PostView } from "@/core/types";
import { LeftRail } from "./components/LeftRail";
import { RightRail } from "./components/RightRail";
import { Toast } from "./components/Toast";
import { NetworkPage } from "./pages/Network";
import { ProfilePage } from "./pages/Profile";
import { RiverPage } from "./pages/River";
import { YouPage } from "./pages/You";
import { useNode } from "./useNode";
import { useToast } from "./useToast";
import { connect, signBytes, signText, type Eip1193Provider } from "./wallet";

export type View =
  | { name: "river" }
  | { name: "network" }
  | { name: "you" }
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PostView[] | null>(null);

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

  useEffect(() => {
    const clean = query.trim();
    if (!clean) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void window.river
        .search(clean)
        .then((found) => setResults(found))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

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
      notify("Sent");
      return event;
    }
    const event = await publish(kind, body, device || undefined);
    notify("Sent");
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
      <div className="mx-auto flex w-full max-w-[1240px] items-start justify-center">
        <LeftRail
          snapshot={snapshot}
          identity={openIdentity}
          view={view}
          onNavigate={setView}
          publish={sealed}
          notify={notify}
          query={query}
          onSearch={setQuery}
        />

        <main className="min-w-0 max-w-[640px] flex-1 border-x border-border/50 pb-24">
          {error && (
            <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 text-sm text-destructive">
              <span className="truncate">{error}</span>
              <button className="ml-auto text-xs underline" onClick={() => void refresh()}>
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
              onOpenYou={() => setView({ name: "you" })}
              writer={writer}
              results={results}
              onClearSearch={() => setQuery("")}
            />
          )}

          {view.name === "network" && (
            <NetworkPage
              snapshot={snapshot}
              identity={openIdentity}
              notify={notify}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
            />
          )}

          {view.name === "you" && (
            <YouPage
              snapshot={snapshot}
              identity={openIdentity}
              wallet={wallet}
              thisDevice={thisDevice}
              devices={devices}
              writer={writer}
              onWriter={setWriter}
              onConnectWallet={(chosen) => void connectWallet(chosen)}
              onDisconnectWallet={() => void disconnectWallet()}
              publish={sealed}
              notify={notify}
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
    <div className="grid h-screen place-items-center px-6">
      <div className="max-w-md text-center">
        <div className="wordmark text-3xl">River<em>.</em></div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {error ?? "starting your node, opening the ledger…"}
        </p>

        {boot?.identityLocked ? (
          <>
            <button
              className="mt-5 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
              disabled={resetting}
              onClick={() => {
                setResetting(true);
                void window.river.resetIdentity();
              }}
            >
              {resetting ? "restarting…" : "start a new identity"}
            </button>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              The unreadable key file is renamed, not deleted. Anything it signed stays in the
              ledger and on the network — but this machine can no longer write as it.
            </p>
          </>
        ) : (
          <div className="mx-auto mt-5 h-0.5 w-56 animate-pulse rounded-full bg-border" />
        )}
      </div>
    </div>
  );
}
