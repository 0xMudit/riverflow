import { useEffect, useRef, useState } from "react";
import { LIMITS } from "@/core/events";
import type { BlobRef } from "@/core/types";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";

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

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  }, [text]);

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
      setError(cause instanceof Error ? cause.message : "could not seal that post");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane" style={{ padding: compact ? "12px 14px" : "16px 18px 12px" }}>
      {replyTo && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 11.5 }}>
          <span className="chip chip-water">replying to {replyTo.name}</span>
          <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={onCancelReply}>
            cancel
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 11 }}>
        <Avatar name={me?.name ?? "you"} hue={me?.hue ?? 200} size={compact ? 26 : 32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {previews.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
              {previews.map((preview, index) => (
                <div key={preview} style={{ position: "relative" }}>
                  <img
                    src={preview}
                    alt=""
                    style={{
                      width: 88,
                      height: 88,
                      objectFit: "cover",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                      display: "block",
                    }}
                  />
                  <button
                    className="btn btn-ghost"
                    style={{ position: "absolute", top: 3, right: 3, padding: "0 5px", fontSize: 10 }}
                    onClick={() => drop(index)}
                    aria-label="Remove this image"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={area}
            className="textarea"
            rows={compact ? 1 : 2}
            maxLength={LIMITS.text}
            placeholder={replyTo ? "Add to this thread…" : "Drop something into the river…"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
            }}
            aria-label="Write a post"
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 8,
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className="meta" style={{ color: remaining < 150 ? "var(--silt)" : undefined }}>
                {remaining}
              </span>
              <span className="meta" style={{ opacity: 0.55 }}>
                ctrl ↵
              </span>
              <input
                ref={picker}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => void attach(event.target.files)}
              />
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11.5 }}
                disabled={busy}
                onClick={() => picker.current?.click()}
                title="Attach an image; it is stored by the hash of its bytes"
              >
                + image
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {chainSeq !== undefined && (
                <span className="meta" style={{ opacity: 0.55, fontSize: 10 }}>
                  event {chainSeq}
                </span>
              )}
              <button
                className="btn btn-primary"
                disabled={!text.trim() || busy}
                onClick={() => void send()}
                title="Signed by your key and appended to your chain, for good"
              >
                {busy ? "sending…" : "Post"}
              </button>
            </div>
          </div>

          {error && <p style={{ color: "var(--danger)", fontSize: 11.5, marginTop: 8 }}>{error}</p>}
        </div>
      </div>
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
