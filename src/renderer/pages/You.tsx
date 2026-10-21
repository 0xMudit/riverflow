import { useEffect, useState } from "react";
import { Download, Upload, Smartphone, Ban, EyeOff, Bell } from "lucide-react";
import type { IdentityInfo, Moderation, ThisDevice, WalletInfo } from "@/core/bridge";
import type { DeviceView, NotificationView, Snapshot } from "@/core/types";
import { plural, shortAddr } from "../format";
import { Copyable } from "../components/Copy";
import { WalletPanel } from "../components/WalletPanel";
import type { PublishFn } from "../useNode";
import type { Eip1193Provider } from "../wallet";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Input } from "@/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

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
  const [local, setLocal] = useState(devices);

  const me = snapshot.me;
  const name = me?.name && me.name !== "unnamed" ? me.name : "unnamed";
  const [draftName, setDraftName] = useState(name === "unnamed" ? "" : name);
  const [draftBio, setDraftBio] = useState(me?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState("");

  const load = () => {
    void window.river
      .moderation()
      .then((list) => setModeration(list))
      .catch(() => undefined);
    void window.river
      .devices()
      .then((list) => setLocal(list))
      .catch(() => undefined);
  };

  useEffect(() => {
    load();
  }, [snapshot.me?.seq]);

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

  const backup = async () => {
    try {
      const key = await window.river.exportKey();
      const payload = JSON.stringify(
        {
          app: "river",
          note: "This private key is the account. Anyone holding it can speak as you. There is no reset.",
          publicKey: identity.publicKey,
          privateKey: key,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `river-key-${identity.publicKey.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("Key file saved — without it, this identity cannot speak again");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not export the key");
    }
  };

  const restore = async () => {
    if (!secret.trim()) return;
    try {
      await window.river.importKey(secret.trim());
      notify("Key accepted — restarting");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "that key was not accepted");
    }
  };

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/90 px-4 py-3.5 backdrop-blur">
        <h1 className="font-serif text-[22px] leading-none tracking-tight">You</h1>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {name} · {plural(snapshot.stats.events, "event")} in your chain ·{" "}
          {plural(snapshot.stats.authors, "person", "people")} known
        </p>
      </header>

      <div className="px-4 py-4">
        <Tabs defaultValue="profile">
          <TabsList className="w-full justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="profile" className="rounded-full">
              Profile
            </TabsTrigger>
            <TabsTrigger value="keys" className="rounded-full">
              Keys
            </TabsTrigger>
            <TabsTrigger value="devices" className="rounded-full">
              Devices
            </TabsTrigger>
            <TabsTrigger value="hidden" className="rounded-full">
              Hidden
            </TabsTrigger>
            <TabsTrigger value="activity" className="rounded-full">
              Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="mt-4 space-y-4">
            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Your profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4 pb-4">
                <Input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder="Your name"
                  aria-label="Your name"
                  maxLength={32}
                />
                <Input
                  value={draftBio}
                  onChange={(event) => setDraftBio(event.target.value)}
                  placeholder="A line about you (optional)"
                  aria-label="Your bio"
                  maxLength={160}
                />
                <Button disabled={saving || !draftName.trim()} onClick={() => void saveProfile()}>
                  {saving ? "saving…" : "Save"}
                </Button>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Your name is written into your chain, so it cannot be taken away — and it cannot be
                  quietly changed either. Your old name stays where it was.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="keys" className="mt-4 space-y-4">
            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Your key</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  It lives in this machine&apos;s keychain, and it never leaves. Everything you write
                  is signed with it, and everything you write stays.
                </p>
                <div className="mt-3">
                  <Copyable
                    value={identity.publicKey}
                    label={shortAddr(identity.publicKey)}
                    className="mono text-xs text-muted-foreground"
                    title={identity.publicKey}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {identity.protected
                    ? "Sealed by the operating system"
                    : "Held in the clear on this machine"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void backup()}>
                    <Download className="size-4" />
                    Back up key
                  </Button>
                </div>
                <div className="mt-3 flex gap-2">
                  <Input
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="Paste a 64-character private key"
                    className="mono text-xs"
                  />
                  <Button size="sm" variant="outline" onClick={() => void restore()}>
                    <Upload className="size-4" />
                    Restore
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Wallet</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <WalletPanel
                  wallet={wallet}
                  onConnect={onConnectWallet}
                  onDisconnect={onDisconnectWallet}
                  notify={notify}
                />
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  A wallet is another way to hold the same authority — MetaMask, a hardware box,
                  anything that speaks EIP-1193. It is optional; the key above works on its own.
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Writing as</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Posts are signed by the key you pick here. A device writes into its own chain, so
                  the history of your identity never forks.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={writer === "" ? "default" : "outline"}
                    className="rounded-full"
                    onClick={() => onWriter("")}
                  >
                    root key
                  </Button>
                  {local
                    .filter((device) => !device.revoked)
                    .map((device) => (
                      <Button
                        key={device.device}
                        size="sm"
                        variant={writer === device.device ? "default" : "outline"}
                        className="rounded-full"
                        onClick={() => onWriter(device.device)}
                        title={device.device}
                      >
                        {device.name || shortAddr(device.device)}
                      </Button>
                    ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="devices" className="mt-4">
            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Devices</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  One identity, many machines. Each keeps its own chain, so a phone and a laptop
                  never fork your history — and a machine you no longer trust can be revoked without
                  touching the past.
                </p>

                {thisDevice && (
                  <div className="mt-4 flex items-center gap-3 border-t border-border/50 pt-3">
                    <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">this machine</div>
                      <Copyable
                        value={thisDevice.publicKey}
                        label={shortAddr(thisDevice.publicKey)}
                        className="mono text-xs text-muted-foreground"
                        title="the device key this machine holds"
                      />
                    </div>
                    {thisDevice.authorised ? (
                      <Badge className="h-5 border-primary/40 bg-primary/10 px-1.5 text-[10px] text-primary">
                        may write
                      </Badge>
                    ) : thisDevice.revoked ? (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        revoked
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => {
                          void window.river
                            .authoriseThisDevice("this machine")
                            .then(() => {
                              load();
                              notify("This machine may now write on its own chain");
                            })
                            .catch((cause: Error) => notify(cause.message));
                        }}
                      >
                        Let it write
                      </Button>
                    )}
                  </div>
                )}

                {local
                  .filter((device) => device.device !== thisDevice?.publicKey)
                  .map((device) => (
                    <div
                      key={device.device}
                      className="flex items-center gap-3 border-t border-border/50 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">{device.name || "unnamed device"}</div>
                        <Copyable
                          value={device.device}
                          label={shortAddr(device.device)}
                          className="mono text-xs text-muted-foreground"
                          title={device.device}
                        />
                      </div>
                      {device.revoked ? (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                          revoked
                        </Badge>
                      ) : (
                        <Badge className="h-5 border-primary/40 bg-primary/10 px-1.5 text-[10px] text-primary">
                          may write
                        </Badge>
                      )}
                      {!device.revoked && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-xs text-muted-foreground"
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
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="hidden" className="mt-4">
            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">What you do not see</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Your choices, kept on this machine and sent nowhere. A mute quiets somebody, a
                  block removes them from your feed, a filter hides any post containing a word.
                  Nothing is deleted anywhere — their history stays on the network.
                </p>

                {moderation.muted.length === 0 &&
                  moderation.blocked.length === 0 &&
                  moderation.filters.length === 0 && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      You have hidden nobody and nothing.
                    </p>
                  )}

                {moderation.blocked.map((target) => (
                  <div
                    key={`block-${target}`}
                    className="flex items-center gap-3 border-t border-border/50 py-2.5 text-sm"
                  >
                    <Ban className="size-4 shrink-0 text-muted-foreground" />
                    <span className="mono min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {shortAddr(target)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs"
                      onClick={() => {
                        void window.river.unblock(target).then(() => {
                          load();
                          notify("Unblocked — their posts are back");
                        });
                      }}
                    >
                      Unblock
                    </Button>
                  </div>
                ))}

                {moderation.muted.map((target) => (
                  <div
                    key={`mute-${target}`}
                    className="flex items-center gap-3 border-t border-border/50 py-2.5 text-sm"
                  >
                    <EyeOff className="size-4 shrink-0 text-muted-foreground" />
                    <span className="mono min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {shortAddr(target)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs"
                      onClick={() => {
                        void window.river.unmute(target).then(() => {
                          load();
                          notify("Unmuted");
                        });
                      }}
                    >
                      Unmute
                    </Button>
                  </div>
                ))}

                {moderation.filters.map((word) => (
                  <div
                    key={`filter-${word}`}
                    className="flex items-center gap-3 border-t border-border/50 py-2.5 text-sm"
                  >
                    <EyeOff className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-serif">“{word}”</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs"
                      onClick={() => {
                        void window.river.removeFilter(word).then(() => {
                          load();
                          notify("Filter removed");
                        });
                      }}
                    >
                      Show again
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="activity" className="mt-4">
            <Card className="border-border/70 bg-card/40">
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">What happened to you</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {notifications.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No replies, ripples or follows yet.
                  </p>
                ) : (
                  notifications.slice(0, 12).map((note) => (
                    <div
                      key={note.id}
                      className="flex items-baseline gap-3 border-t border-border/50 py-2 text-sm first:border-t-0"
                    >
                      <Bell className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="label text-[9px]">{note.kind}</span>
                      <span className="mono min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {shortAddr(note.actor)}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {new Date(note.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))
                )}
                {snapshot.unread > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-3 h-8 px-2 text-xs"
                    onClick={() => {
                      void window.river.markRead().then(() => {
                        setNotifications([]);
                        notify("Marked read");
                      });
                    }}
                  >
                    Mark read
                  </Button>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
