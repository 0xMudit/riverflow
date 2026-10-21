import { useState } from "react";
import { Heart, MessageCircle, MoreHorizontal, Pencil, EyeOff, Ban, Trash2, ScrollText, Link2 } from "lucide-react";
import type { Event, PostView, ProfileView } from "@/core/types";
import { profileOf, shortAddr, shortHash, timeAgo } from "../format";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { Copyable } from "./Copy";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

const KIND_LABEL: Record<string, string> = {
  post: "written",
  edit: "edited",
  retract: "retracted",
  reaction: "rippled",
};

function TrailRow({ event }: { event: Event }) {
  return (
    <div className="flex items-baseline gap-2 py-1.5 text-xs">
      <span className="label text-[9px]">{KIND_LABEL[event.kind] ?? event.kind}</span>
      <span className="mono truncate text-muted-foreground">
        <span className="opacity-50">#{event.seq}</span>{" "}
        <Copyable
          value={event.id}
          label={shortHash(event.id, 8, 6)}
          className="mono"
          title={`event ${event.id}`}
        />
        {event.kind === "retract" && event.body.reason ? (
          <span className="text-silt"> — “{event.body.reason}”</span>
        ) : null}
        {event.kind === "edit" ? (
          <span className="opacity-60">
            {" "}
            → “{(event.body.text ?? "").slice(0, 36)}
            {(event.body.text ?? "").length > 36 ? "…" : ""}”
          </span>
        ) : null}
      </span>
      <span className="mono ml-auto shrink-0 text-[10px] text-primary" title="signature verified on ingest">
        ✓
      </span>
    </div>
  );
}

export function PostCard({
  post,
  profiles,
  me,
  publish,
  notify,
  isReply = false,
  replyContext,
  onOpenProfile,
}: {
  post: PostView;
  profiles: Record<string, ProfileView>;
  me: string;
  publish: PublishFn;
  notify: (message: string) => void;
  isReply?: boolean;
  replyContext?: { name: string };
  onOpenProfile: (pubkey: string) => void;
}) {
  const author = profileOf(profiles, post.author);
  const isMine = me === post.author;

  const [showTrail, setShowTrail] = useState(false);
  const [trail, setTrail] = useState<Event[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [menu, setMenu] = useState(false);
  const [word, setWord] = useState("");
  const [draft, setDraft] = useState(post.text);
  const [busy, setBusy] = useState(false);

  const blocked = post.retracted;

  const openTrail = async () => {
    const next = !showTrail;
    setShowTrail(next);
    if (next && trail === null) {
      try {
        setTrail(await window.river.trail(post.id));
      } catch {
        setTrail([]);
      }
    }
  };

  const react = async () => {
    try {
      await publish("reaction", { target: post.id, emoji: post.viewerReacted ? "" : "≈" });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not react");
    }
  };

  const saveEdit = async () => {
    const next = draft.trim();
    if (!next || next === post.text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await publish("edit", { target: post.id, text: next });
      setEditing(false);
      notify("Edited — the old text stays on your chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not edit");
    } finally {
      setBusy(false);
    }
  };

  const retract = async () => {
    const confirmed = window.confirm(
      "Retract this post?\n\nIt will disappear from the river, but it is not deleted. The words stay on your chain forever, and this retraction becomes an event of its own.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await publish("retract", { target: post.id, reason: "retracted by author" });
      notify("Retracted — the words remain on the chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not retract");
    } finally {
      setBusy(false);
    }
  };

  /** Hide this person from your feed. Nothing is deleted; you can undo it. */
  const blockAuthor = async () => {
    const confirmed = window.confirm(
      `Block ${author.name}?\n\nTheir posts leave your feed. Nothing is deleted — their history stays on the network — and you can undo this under You.`,
    );
    if (!confirmed) return;
    try {
      await window.river.block(post.author);
      notify(`${author.name} is blocked — undo it under You`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not block that");
    }
  };

  /** Hide any post that says this word, whoever wrote it. */
  const hideWord = async () => {
    const clean = word.trim();
    if (!clean) return;
    try {
      await window.river.addFilter(clean);
      notify(`Posts saying “${clean}” are hidden here`);
      setWord("");
      setFiltering(false);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not add that filter");
    }
  };

  return (
    <article
      className={`px-4 py-3.5 transition-colors hover:bg-accent/25 ${
        isReply ? "border-l-2 border-l-transparent" : ""
      } ${blocked ? "opacity-70" : ""}`}
    >
      <div className="flex items-start gap-3">
        <button onClick={() => onOpenProfile(post.author)} aria-label={`Open ${author.name}`}>
          <Avatar name={author.name} hue={author.hue} size={isReply ? "sm" : "md"} title={post.author} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <button
              className="truncate font-semibold hover:underline"
              onClick={() => onOpenProfile(post.author)}
            >
              {author.name}
            </button>
            {isReply && replyContext && (
              <span className="truncate text-xs text-muted-foreground">↳ {replyContext.name}</span>
            )}
            {blocked && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] text-silt">
                retracted
              </Badge>
            )}
            <span
              className="ml-auto shrink-0 text-xs text-muted-foreground"
              title={new Date(post.createdAt).toLocaleString()}
            >
              {timeAgo(post.createdAt)}
            </span>
          </div>

          {editing ? (
            <div className="mt-2">
              <textarea
                className="prose-post w-full resize-y rounded-md border border-input bg-transparent p-2.5 text-sm outline-none focus:border-ring"
                rows={4}
                value={draft}
                maxLength={2000}
                onChange={(event) => setDraft(event.target.value)}
                autoFocus
              />
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" disabled={busy} onClick={() => void saveEdit()}>
                  {busy ? "saving…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">the old text stays</span>
              </div>
            </div>
          ) : blocked ? (
            <div className="mt-1.5">
              {revealed ? (
                <p className="prose-post text-muted-foreground">{post.text}</p>
              ) : (
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  This post was retracted by its author. Nothing was erased.
                </p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setRevealed((value) => !value)}>
                  {revealed ? "hide" : "show the original"}
                </Button>
                <span className="text-xs text-muted-foreground">it is still in the chain</span>
              </div>
            </div>
          ) : (
            <>
              <p className="prose-post mt-1">{post.text}</p>
              {post.media && post.media.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {post.media.map((item) => (
                    <img
                      key={item.hash}
                      src={`river://blob/${item.hash}`}
                      alt=""
                      loading="lazy"
                      className="max-h-96 w-auto max-w-full rounded-xl border border-border object-contain"
                      title={item.width && item.height ? `${item.width}×${item.height}` : undefined}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          <div className="mt-1.5 flex items-center gap-1 text-muted-foreground">
            {!blocked && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-8 gap-1.5 px-2 ${post.viewerReacted ? "text-primary" : ""}`}
                  onClick={() => void react()}
                  title={post.viewerReacted ? "Take it back (it stays on your chain)" : "Ripple"}
                >
                  <Heart className={post.viewerReacted ? "size-4 fill-current" : "size-4"} />
                  {post.reactions > 0 && <span className="text-xs tabular-nums">{post.reactions}</span>}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2"
                  onClick={() => setReplying((value) => !value)}
                >
                  <MessageCircle className="size-4" />
                  {post.replyCount > 0 && <span className="text-xs tabular-nums">{post.replyCount}</span>}
                </Button>
              </>
            )}

            <DropdownMenu open={menu} onOpenChange={setMenu}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="More">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(post.id)}>
                  <Link2 className="size-4" />
                  Copy link
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void openTrail()}>
                  <ScrollText className="size-4" />
                  Provenance
                </DropdownMenuItem>
                {isMine && !blocked && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      <Pencil className="size-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void retract()}
                      className="text-silt focus:text-silt"
                    >
                      <Trash2 className="size-4" />
                      Retract
                    </DropdownMenuItem>
                  </>
                )}
                {!blocked && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setFiltering(true)}>
                      <EyeOff className="size-4" />
                      Hide a word
                    </DropdownMenuItem>
                  </>
                )}
                {!isMine && !blocked && (
                  <DropdownMenuItem onSelect={() => void blockAuthor()}>
                    <Ban className="size-4" />
                    Block
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {filtering && !blocked && (
            <div className="mt-2 flex items-center gap-2">
              <input
                className="h-9 w-56 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus:border-ring"
                placeholder="a word to hide"
                value={word}
                onChange={(event) => setWord(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void hideWord();
                }}
                autoFocus
              />
              <Button size="sm" disabled={!word.trim()} onClick={() => void hideWord()}>
                Hide posts
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFiltering(false)}>
                Cancel
              </Button>
            </div>
          )}

          {replying && !blocked && (
            <div className="mt-2">
              <Composer
                me={
                  me
                    ? { pubkey: me, name: profileOf(profiles, me).name, hue: profileOf(profiles, me).hue }
                    : null
                }
                publish={publish}
                compact
                autoFocus
                replyTo={{ id: post.id, name: author.name }}
                onCancelReply={() => setReplying(false)}
              />
            </div>
          )}

          {showTrail && (
            <div className="mt-3 rounded-lg border border-border bg-background/60 px-3 py-1.5">
              <div className="flex items-center justify-between py-1.5">
                <span className="label text-[9px]">Provenance</span>
                <span className="text-[10px] text-muted-foreground">
                  {trail ? `${trail.length} event${trail.length === 1 ? "" : "s"}` : "reading…"} · immutable
                </span>
              </div>
              {(trail ?? []).map((event) => (
                <TrailRow key={event.id} event={event} />
              ))}
              <p className="pb-2 pt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                Every line above is a signature. None of it can be withdrawn.
              </p>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
