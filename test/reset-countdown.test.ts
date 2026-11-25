import { expect, test } from "bun:test";
import { nextCountdownChange, resetCountdown } from "../client/reset-countdown";

const now = Date.parse("2026-03-10T09:00:00Z");
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const at = (offset: number) => new Date(now + offset).toISOString();

test("more than a day left shows days and hours", () => {
  expect(resetCountdown(at(5 * day + 2 * hour + 40 * minute), now, "ko")).toBe("5일 2시간 남음");
  expect(resetCountdown(at(5 * day + 2 * hour + 40 * minute), now, "en")).toBe("5d 2h left");
  expect(resetCountdown(at(3 * day + 59 * minute), now, "ko")).toBe("3일 남음");
  expect(resetCountdown(at(3 * day + 59 * minute), now, "en")).toBe("3d left");
});

test("exactly a day left is one day, just under is hours and minutes", () => {
  expect(resetCountdown(at(day), now, "ko")).toBe("1일 남음");
  expect(resetCountdown(at(day), now, "en")).toBe("1d left");
  expect(resetCountdown(at(day - 1), now, "ko")).toBe("23시간 59분 남음");
  expect(resetCountdown(at(day - 1), now, "en")).toBe("23h 59m left");
});

test("under a day shows hours and minutes", () => {
  expect(resetCountdown(at(3 * hour + 12 * minute + 30_000), now, "ko")).toBe("3시간 12분 남음");
  expect(resetCountdown(at(3 * hour + 12 * minute + 30_000), now, "en")).toBe("3h 12m left");
  expect(resetCountdown(at(2 * hour), now, "ko")).toBe("2시간 남음");
  expect(resetCountdown(at(2 * hour), now, "en")).toBe("2h left");
});

test("under an hour shows minutes, under a minute shows resets soon", () => {
  expect(resetCountdown(at(hour), now, "ko")).toBe("1시간 남음");
  expect(resetCountdown(at(hour - 1), now, "ko")).toBe("59분 남음");
  expect(resetCountdown(at(59 * minute), now, "en")).toBe("59m left");
  expect(resetCountdown(at(minute), now, "ko")).toBe("1분 남음");
  expect(resetCountdown(at(minute), now, "en")).toBe("1m left");
  expect(resetCountdown(at(minute - 1), now, "ko")).toBe("곧 초기화");
  expect(resetCountdown(at(1), now, "en")).toBe("resets soon");
});

test("a passed, current, missing or unreadable reset time shows nothing", () => {
  for (const reset of [at(0), at(-1), at(-day), null, undefined, "", "not a date"]) {
    expect(resetCountdown(reset, now, "ko")).toBeNull();
    expect(resetCountdown(reset, now, "en")).toBeNull();
  }
  expect(resetCountdown(at(hour), Number.NaN, "ko")).toBeNull();
});

test("the next refresh lands when the shown minute changes or the reset passes", () => {
  expect(nextCountdownChange([at(5 * minute)], now)).toBe(1);
  expect(nextCountdownChange([at(5 * minute + 20_000)], now)).toBe(20_001);
  expect(nextCountdownChange([at(30_000)], now)).toBe(30_000);
  expect(nextCountdownChange([at(3 * hour + 45_000), at(day + 10_000)], now)).toBe(10_001);
  expect(nextCountdownChange([at(-minute), null, "not a date", at(2 * day + 59_999)], now)).toBe(minute);
});

test("nothing to count down needs no refresh", () => {
  expect(nextCountdownChange([], now)).toBeNull();
  expect(nextCountdownChange([at(0), at(-hour), null, "bad"], now)).toBeNull();
});
