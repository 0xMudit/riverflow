import { useEffect, useRef, useState } from "react";
import { LIMITS } from "@/core/events";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";

/**
 * The composer. It builds one signed event and appends it to your own chain.
 * No draft is saved: until you mean it, a thought is not part of the record.
 */
export function Composer({
  me,
  chainSeq,
  publish,
  replyTo,
  onCancelReply,
  autoFocus,
  compact,
}: {
  me: { pubkey: string; name: string; hue: number } | null;
  chainSeq?: number;
  publish: PublishFn;
  replyTo?: { id: string; name: string } | null;
  onCancelReply?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus, replyTo?.id]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
  }, [text]);

  const remaining = LIMITS.text - text.length;

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await publish("post", { text: body, ...(replyTo ? { replyTo: replyTo.id } : {}) });
      setText("");
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
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {chainSeq !== undefined && (
                <span className="meta" style={{ opacity: 0.55, fontSize: 10 }}>
                  event {chainSeq}
                </span>
              )}
              <button className="btn btn-primary" disabled={!text.trim() || busy} onClick={() => void send()}>
                {busy ? "signing…" : "Sign & seal"}
              </button>
            </div>
          </div>

          {error && <p style={{ color: "var(--danger)", fontSize: 11.5, marginTop: 8 }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
