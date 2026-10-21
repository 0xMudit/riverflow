import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-7 text-[10px]",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-14 text-base",
} as const;

/** A circle with two letters in it, coloured by the person's key. */
export function Avatar({
  name,
  hue,
  size = "md",
  title,
  className,
}: {
  name: string;
  hue: number;
  size?: keyof typeof SIZES;
  title?: string;
  className?: string;
}) {
  const initials = (name || "?").trim().slice(0, 2).toUpperCase();
  return (
    <AvatarPrimitive.Root
      className={cn(
        "relative flex shrink-0 overflow-hidden rounded-full avatar-ring",
        SIZES[size],
        className,
      )}
      title={title}
    >
      <AvatarPrimitive.Fallback
        className="flex h-full w-full items-center justify-center font-semibold text-[#05100e]"
        style={{ background: `hsl(${hue} 58% 62%)` }}
        delayMs={0}
      >
        {initials}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
