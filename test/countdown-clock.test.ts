import { expect, test } from "bun:test";
import { countdownClock, type ClockHost } from "../client/countdown-clock";

const start = Date.parse("2026-03-10T09:00:00Z");
const minute = 60_000;
const at = (offset: number) => new Date(start + offset).toISOString();

function fakeHost(state = "active") {
  let time = start, nextId = 1, appState = state;
  const timers = new Map<number, { due: number; run: () => void }>();
  const listeners = new Set<(state: string) => void>();
  const host: ClockHost = {
    now: () => time,
    appState: () => appState,
    setTimer: (run, wait) => { const id = nextId++; timers.set(id, { due: time + wait, run }); return id; },
    clearTimer: id => { timers.delete(id as number); },
    onAppState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {
    host, timers, listeners,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        timers.delete(due[0]); time = due[1].due; due[1].run();
      }
      time = end;
    },
    setAppState(next: string) { appState = next; listeners.forEach(listener => listener(next)); },
  };
}

function track(state?: string) {
  const fake = fakeHost(state);
  const ticks: number[] = [];
  const clock = countdownClock(fake.host, now => ticks.push(now));
  return { fake, ticks, clock };
}

test("the clock ticks when the shown minute changes and when a reset passes", () => {
  const { fake, ticks, clock } = track();
  clock.setResets([at(2 * minute + 20_000)]);
  expect(ticks).toEqual([start]);
  fake.advance(20_000);
  expect(ticks).toEqual([start]);
  fake.advance(1);
  expect(ticks).toEqual([start, start + 20_001]);
  fake.advance(2 * minute);
  expect(ticks).toEqual([start, start + 20_001, start + minute + 20_001, start + 2 * minute + 20_000]);
  expect(fake.timers.size).toBe(0);
});

test("new reset times resync the clock to the real time, even after it went idle", () => {
  const { fake, ticks, clock } = track();
  clock.setResets([]);
  expect(fake.timers.size).toBe(0);
  fake.advance(5 * minute);
  clock.setResets([at(5 * minute + 30_000)]);
  expect(ticks).toEqual([start, start + 5 * minute]);
  fake.advance(30_000);
  expect(ticks.at(-1)).toBe(start + 5 * minute + 30_000);
});

test("the same reset times do not tick again or add a second timer", () => {
  const { fake, ticks, clock } = track();
  clock.setResets([at(10 * minute + 5_000)]);
  clock.setResets([at(10 * minute + 5_000)]);
  expect(ticks).toEqual([start]);
  expect(fake.timers.size).toBe(1);
});

test("the clock pauses in the background and catches up on return", () => {
  const { fake, ticks, clock } = track();
  clock.setResets([at(30 * minute)]);
  fake.setAppState("background");
  expect(fake.timers.size).toBe(0);
  fake.advance(10 * minute);
  expect(ticks).toEqual([start]);
  fake.setAppState("active");
  expect(ticks).toEqual([start, start + 10 * minute]);
  expect(fake.timers.size).toBe(1);
});

test("inactive is still foreground, and a clock started in the background waits", () => {
  const inactive = track();
  inactive.clock.setResets([at(30 * minute)]);
  inactive.fake.setAppState("inactive");
  expect(inactive.fake.timers.size).toBe(1);

  const hidden = track("background");
  hidden.clock.setResets([at(30 * minute)]);
  expect(hidden.ticks).toEqual([start]);
  expect(hidden.fake.timers.size).toBe(0);
  hidden.fake.advance(minute);
  hidden.fake.setAppState("active");
  expect(hidden.ticks).toEqual([start, start + minute]);
  expect(hidden.fake.timers.size).toBe(1);
});

test("stopping clears the timer and the app state listener, and nothing ticks afterwards", () => {
  const { fake, ticks, clock } = track();
  clock.setResets([at(3 * minute)]);
  clock.stop();
  expect(fake.timers.size).toBe(0);
  expect(fake.listeners.size).toBe(0);
  fake.advance(10 * minute);
  clock.setResets([at(20 * minute)]);
  expect(ticks).toEqual([start]);
  expect(fake.timers.size).toBe(0);
});
