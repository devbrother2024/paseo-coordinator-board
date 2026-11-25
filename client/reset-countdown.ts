const minute = 60_000, hour = 60 * minute, day = 24 * hour;

function remaining(reset: string | null | undefined, now: number) {
  const left = reset ? Date.parse(reset) - now : Number.NaN;
  return Number.isFinite(left) && left > 0 ? left : null;
}

// Time left until a usage limit resets, rounded down so it never promises more than is left.
// A reset that has passed or cannot be read shows nothing, matching how the card hides passed resets.
export function resetCountdown(reset: string | null | undefined, now: number, language: "ko" | "en") {
  const left = remaining(reset, now);
  if (left === null) return null;
  const ko = language === "ko";
  if (left < minute) return ko ? "곧 초기화" : "resets soon";
  const [size, unit, part, partUnit] = left >= day ? [day, ko ? "일" : "d", hour, ko ? "시간" : "h"] as const
    : left >= hour ? [hour, ko ? "시간" : "h", minute, ko ? "분" : "m"] as const
      : [minute, ko ? "분" : "m", 0, ""] as const;
  const minor = part ? Math.floor(left % size / part) : 0;
  const text = Math.floor(left / size) + unit + (minor ? " " + minor + partUnit : "");
  return ko ? text + " 남음" : text + " left";
}

// Milliseconds until any shown countdown changes its minute or reaches its reset, or null when none is counting.
export function nextCountdownChange(resets: readonly (string | null | undefined)[], now: number) {
  let next: number | null = null;
  for (const reset of resets) {
    const left = remaining(reset, now);
    if (left === null) continue;
    const wait = Math.min(left, left % minute + 1);
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}
