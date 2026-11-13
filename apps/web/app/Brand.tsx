/** Shared approved FLOW identity. Images carry the complete custom wordmark. */
export default function Brand({
  dark = false,
  compact = false,
  className = "",
}: {
  dark?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={
        "huitu-brand " +
        (dark ? "on-dark " : "") +
        (compact ? "is-compact " : "") +
        className
      }
    >
      <img
        className="brand-lockup"
        src={"/brand/flow-logo-" + (dark ? "dark" : "light") + "-v1.png"}
        alt="汇途 HUITU"
        width={1774}
        height={887}
      />
      <img
        className="brand-symbol"
        src="/brand/flow-symbol-v1.png"
        alt="汇途"
        width={1254}
        height={1254}
      />
    </span>
  );
}
export function PortalBrand({ area, code }: { area: string; code: string }) {
  return (
    <div className="portal-brandbar">
      <a href="/workspace" aria-label="汇途工作台首页">
        <Brand dark />
      </a>
      <span className="portal-area">{area}</span>
      <span className="portal-code">{code}</span>
    </div>
  );
}
