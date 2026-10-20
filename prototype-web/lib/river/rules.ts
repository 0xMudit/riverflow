/**
 * Reference rules — the only gate between a signed event and the chain.
 *
 * A signature proves *who* spoke. These rules decide whether what they said is
 * meaningful right now: you may only edit your own post, you may only reply to
 * something that exists, you may only follow a real identity. Once an event
 * passes, it is permanent — so this is the one place worth being strict.
 */
import type { RiverEvent } from "./types";
import type { RiverState } from "./project";

export function checkReferences(state: RiverState, event: RiverEvent): string | null {
  const body = event.body ?? {};

  switch (event.kind) {
    case "post": {
      if (state.posts[event.id]) return "this exact post is already on the chain";
      if (body.replyTo) {
        const parent = state.posts[body.replyTo];
        if (!parent) return "you are replying to a post that does not exist";
        if (parent.retracted) return "you cannot reply to silt";
      }
      return null;
    }
    case "edit": {
      const post = state.posts[body.target ?? ""];
      if (!post) return "no such post";
      if (post.author !== event.author) return "you can only edit your own posts";
      if (post.retracted) return "this post is retracted; retracted posts cannot be edited";
      return null;
    }
    case "retract": {
      const post = state.posts[body.target ?? ""];
      if (!post) return "no such post";
      if (post.author !== event.author) return "you can only retract your own posts";
      if (post.retracted) return "already retracted";
      return null;
    }
    case "reaction": {
      const post = state.posts[body.target ?? ""];
      if (!post) return "no such post";
      if (post.retracted) return "you cannot react to silt";
      return null;
    }
    case "follow": {
      const target = body.target ?? "";
      if (!state.profiles[target]) return "no such identity";
      return null;
    }
    case "profile":
      return null;
    default:
      return "unknown event kind";
  }
}
