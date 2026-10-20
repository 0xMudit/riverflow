"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { LIMITS } from "@/lib/river/events";
import { profileOf, type RiverState } from "@/lib/river/project";
import type { EventBody, EventKind } from "@/lib/river/types";

/**
 * The composer. It does one thing: build a signed event and send it to the only
 * write endpoint the app has. There is no draft autosave, because a draft is
 * not part of the river until you mean it.
 */
export function Composer({
  state,
  me,
  submit,
  replyTo,
  onCancelReply,
  autoFocus,
  compact,
}: {
  state: RiverState | null;
  me: { publicKey: string } | null;
  submit: (kind: EventKind, body: EventBody) => Promise<{ index: number; hash: string }>;
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

  const profile = me && state ? profileOf(state, me.publicKey) : null;
  const remaining = LIMITS.text - text.length;

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit("post", { text: body, ...(replyTo ? { replyTo: replyTo.id } : {}) });
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 10,
            fontSize: 11.5,
          }}
        >
          <span className="chip chip-water">replying to {replyTo.name}</span>
          <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={onCancelReply}>
            cancel
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 11 }}>
        <Avatar
          name={profile?.name ?? "you"}
          hue={profile?.hue ?? 200}
          size={compact ? 26 : 32}
        />
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
              <span className="meta" style={{ color: remaining < 120 ? "var(--silt)" : undefined }}>
                {remaining}
              </span>
              <span className="meta" style={{ opacity: 0.55 }}>
                ⌘↵ to seal
              </span>
            </div>
            <button
              className="btn btn-primary"
              disabled={!text.trim() || busy || !me}
              onClick={() => void send()}
            >
              {busy ? "mining…" : "Sign & seal"}
            </button>
          </div>

          {error && (
            <p style={{ color: "var(--danger)", fontSize: 11.5, marginTop: 8 }}>{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
