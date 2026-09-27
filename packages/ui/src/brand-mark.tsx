export interface BrandMarkProps {
  compact?: boolean;
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div
      className={`brand-mark${compact ? " brand-mark--compact" : ""}`}
      aria-label="Patio"
    >
      <span className="brand-mark__word">Patio</span>
    </div>
  );
}
