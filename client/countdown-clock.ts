import { nextCountdownChange } from "./reset-countdown";

// What the clock needs from the platform. The screen passes React Native's AppState and the real timers;
// tests pass a fake so every transition can be checked without rendering.
export type ClockHost = {
  now(): number;
  appState(): string;
  setTimer(run: () => void, wait: number): unknown;
  clearTimer(timer: unknown): void;
  onAppState(listener: (state: string) => void): () => void;
};

// Drives the current time for the reset countdowns. It reads the real time and ticks when new reset times
// arrive, when a shown minute changes or a reset passes, and when the app returns to the foreground.
// It holds no timer in the background or when nothing is counting down, and stop() ends it for good.
export function countdownClock(host: ClockHost, tick: (now: number) => void) {
  let resets: readonly (string | null)[] = [];
  let key: string | null = null;
  let timer: unknown = null;
  let foreground = host.appState() !== "background";
  let stopped = false;

  const clear = () => {
    if (timer !== null) host.clearTimer(timer);
    timer = null;
  };
  const refresh = () => {
    clear();
    const now = host.now();
    tick(now);
    if (!foreground) return;
    const wait = nextCountdownChange(resets, now);
    if (wait !== null) timer = host.setTimer(() => { timer = null; if (!stopped) refresh(); }, wait);
  };
  const unsubscribe = host.onAppState(state => {
    if (stopped) return;
    const next = state !== "background";
    if (next === foreground) return;
    foreground = next;
    if (foreground) refresh();
    else clear();
  });

  return {
    setResets(next: readonly (string | null)[]) {
      const nextKey = JSON.stringify(next);
      if (stopped || nextKey === key) return;
      resets = [...next];
      key = nextKey;
      refresh();
    },
    stop() {
      stopped = true;
      clear();
      unsubscribe();
    },
  };
}
