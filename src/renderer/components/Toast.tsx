export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: 99,
          background: "var(--water)",
          boxShadow: "0 0 8px rgba(91,217,194,0.9)",
        }}
      />
      <span>{message}</span>
    </div>
  );
}
