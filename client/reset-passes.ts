import type { ResetPass } from "../shared/usage-routing";
import { resetCountdown } from "./reset-countdown";

export type ResetPassRow = { key: string; name: string; value: string; empty: boolean; expiry: string | null; note?: string };

// The soonest expiry still ahead. Passed dates are not shown, while the count left stays as the host reported it.
export function nearestExpiry(pass: ResetPass, now: number) {
  let nearest: string | null = null;
  for (const stamp of pass.expiresAt) {
    const at = Date.parse(stamp);
    if (Number.isFinite(at) && at > now && (nearest === null || at < Date.parse(nearest))) nearest = stamp;
  }
  return nearest;
}

// One line per pass for the account card: how many are left and, when some are, the nearest expiry with time left.
export function resetPassRows(passes: readonly ResetPass[] | undefined, now: number, language: "ko" | "en",
  t: (ko: string, en: string) => string, date: (stamp: string) => string): ResetPassRow[] {
  return (passes ?? []).map((pass, index) => {
    const empty = pass.left === 0;
    const nearest = empty ? null : nearestExpiry(pass, now);
    const left = nearest && resetCountdown(nearest, now, language, t("곧 만료", "expires soon"));
    return {
      key: pass.id + ":" + index, name: pass.label,
      value: empty ? t("없음", "None") : t(`${pass.left}장 남음`, `${pass.left} left`), empty,
      expiry: nearest ? [t(`가장 가까운 만료 ${date(nearest)}`, `Next expiry ${date(nearest)}`), left].filter(Boolean).join(" · ") : null,
      note: pass.note,
    };
  });
}
