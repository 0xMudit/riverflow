import { CheckCircle2 } from "lucide-react";

/** One line, at the bottom, saying what just happened. */
export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-border bg-popover/95 px-4 py-2.5 text-sm text-foreground shadow-lg backdrop-blur">
        <CheckCircle2 className="size-4 shrink-0 text-primary" />
        {message}
      </div>
    </div>
  );
}
