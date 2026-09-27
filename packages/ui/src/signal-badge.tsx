export interface SignalBadgeProps {
  state: "live" | "off-air" | "testing" | "locked";
  children?: React.ReactNode;
}

export function SignalBadge({ state, children }: SignalBadgeProps) {
  return (
    <span className={`signal-badge signal-badge--${state}`}>
      <span className="signal-badge__dot" aria-hidden="true" />
      {children ?? state}
    </span>
  );
}
