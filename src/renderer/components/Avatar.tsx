import { initials } from "@/renderer/format";

export function Avatar({
  name,
  hue,
  size = 34,
  title,
}: {
  name: string;
  hue: number;
  size?: number;
  title?: string;
}) {
  return (
    <div
      className="avatar"
      title={title}
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.34)),
        background: `linear-gradient(155deg, hsl(${hue} 50% 68%), hsl(${(hue + 34) % 360} 44% 50%))`,
      }}
    >
      {initials(name)}
    </div>
  );
}
