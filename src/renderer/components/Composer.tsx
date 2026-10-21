import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { LIMITS } from "@/core/events";
import type { BlobRef } from "@/core/types";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";

/**
 * The composer. It builds one signed event and appends to your chain.
 * No draft is saved: until you mean it, a thought is not part of the record.
 * Media is handed to the node first, which checks it against its hash and
 * keeps it under that hash — the event carries the reference, not the bytes.
 */
export function Composer({
  me,
  chainSeq,
  publish,
  replyTo,
  onCancelReply,
  autoFocus,
  compact,
  device,
}: {
  me: { pubkey: string; name: string; hue: number } | null;
  chainSeq?: number;
  publish: PublishFn;
  replyTo?: { id: string; name: string } | null;
  onCancelReply?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
  /** the device key to write with; empty means the root key */
  device?: string;
}) {
  const [text, setText] = useState("");
  const [media, setMedia] = useState<BlobRef[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus, replyTo?.id]);

  useEffect(
    () => () => {
      for (const preview of previews) URL.revokeObjectURL(preview);
    },
    [previews],
  );

  const remaining = LIMITS.text - text.length;

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const item of Array.from(files)) {
        const bytes = new Uint8Array(await item.arrayBuffer());
        const box = await dimensions(item);
        const size = await window.river.attachMedia(bytes, item.type, box.width, box.height);
        setMedia((current) => [...current, size]);
        setPreviews((current) => [...current, URL.createObjectURL(item)]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not attach that");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };

  const drop = (index: number) => {
    setMedia((current) => current.filter((_, position) => position !== index));
    setPreviews((current) => {
      const next = current.filter((_, position) => position !== index);
      URL.revokeObjectURL(current[index] as string);
      return next;
    });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await publish(
        "post",
        {
          text: body,
          ...(replyTo ? { replyTo: replyTo.id } : {}),
          ...(media.length > 0 ? { media } : {}),
        },
        device,
      );
      setText("");
      setMedia([]);
      setPreviews([]);
      onCancelReply?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "could not send that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/70 bg-card/60">
      {replyTo && (
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          Replying to {replyTo.name}
          <button className="ml-auto hover:text-foreground" onClick={onCancelReply}>
            cancel
          </button>
        </div>
      )}

      <div className="flex gap-3 p-3.5">
        <Avatar name={me?.name ?? "you"} hue={me?.hue ?? 200} size={compact ? "sm" : "md"} />

        <div className="min-w-0 flex-1">
          {previews.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-2">
              {previews.map((preview, index) => (
                <div key={preview} className="relative">
                  <img
                    src={preview}
                    alt=""
                    className="size-24 rounded-xl border border-border object-cover"
                  />
                  <button
                    className="absolute right-1 top-1 rounded-full bg-background/80 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => drop(index)}
                    aria-label="Remove this image"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <Textarea
            ref={area}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
            }}
            maxLength={LIMITS.text}
            placeholder={replyTo ? "Add to this thread…" : "What's happening?"}
            aria-label="Write a post"
            className="min-h-[64px] resize-none border-0 bg-transparent px-0 text-[17px] leading-relaxed shadow-none outline-none focus-visible:ring-0"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-3.5 py-2">
        <div className="flex items-center gap-1">
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => void attach(event.target.files)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-primary"
            disabled={busy}
            onClick={() => picker.current?.click()}
            title="Attach an image"
          >
            <ImageIcon className="size-4" />
          </Button>
          {remaining < 100 && (
            <span className="text-xs text-muted-foreground tabular-nums">{remaining}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {chainSeq !== undefined && (
            <span className="text-[11px] text-muted-foreground">event {chainSeq}</span>
          )}
          <Button size="sm" disabled={!text.trim() || busy} onClick={() => void send()}>
            {busy ? "sending…" : "Post"}
          </Button>
        </div>
      </div>

      {error && <p className="px-3.5 pb-3 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The size of an image, so the feed can lay it out before it loads. */
async function dimensions(file: File): Promise<{ width?: number; height?: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}
