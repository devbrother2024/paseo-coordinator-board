import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_STALE_HOURS = 12;
// Host setting: how long a finished session may wait before the board flags it
// as not yet handled by the coordinator. The default spans two regular digests.
export const reviewWaitSetting = defineSettings({
  id: "review-wait", scope: "host", version: 1,
  schema: z.object({ staleHours: z.number().int().min(1).max(168).default(DEFAULT_STALE_HOURS) }),
});

type Translate = (korean: string, english: string) => string;
const SUMMARY_LIMIT = 160;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Session text is untrusted. Drop control characters (except tab and newline),
// bidirectional overrides and zero-width characters before showing it.
export function cleanSessionText(text: string) {
  return text.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
}

const stopWords = /멈추|멈춘|멈춥|멈췄|멈춤|기다리|기다린|기다립|기다렸|정지|중단|보류|막혀|막혔|막힌|대기(?!열)|\b(?:stop(?:s|ped|ping)?|wait(?:s|ed|ing)?|blocked|paused?|on hold|halt(?:s|ed)?)\b/i;

// "no longer blocked", "기다리지 않습니다" say the opposite of a stop.
const negatedStop = /\b(?:no longer|not|never)\s+(?:be(?:ing)?\s+)?(?:stopped|waiting|blocked|paused|on hold|halted)\b|(?:멈추|기다리|정지하|중단하|보류하)지\s*(?:않|말)/gi;

function saysStopped(sentence: string) {
  return stopWords.test(sentence.replace(negatedStop, ""));
}

function plainLine(line: string) {
  let value = line.trim();
  if (/^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(value)) return "";
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(/^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/, "").trim();
  }
  return value
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\*\*|__|~~|`|\*/g, "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string) {
  const chars = Array.from(text);
  return chars.length > SUMMARY_LIMIT ? chars.slice(0, SUMMARY_LIMIT - 1).join("") + "…" : text;
}

// One line for the card: the last sentence that says the session stopped or is
// waiting, otherwise the last paragraph of the message.
export function lastMessageSummary(text: string) {
  const body = cleanSessionText(text).replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "");
  const paragraphs = body.split(/\n\s*\n/).map(block => block.split("\n").map(plainLine).filter(Boolean)).filter(lines => lines.length);
  const sentences = paragraphs.flat().flatMap(line => line.split(/(?<=[.!?。！？])\s+/));
  const stopped = sentences.findLast(saysStopped);
  return clip((stopped ?? paragraphs.at(-1)?.join(" ") ?? "").trim());
}

export function waitedFor(since: string | undefined, now: number): { unit: "minute" | "hour" | "day"; value: number } | null {
  const start = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(start)) return null;
  const elapsed = Math.max(0, now - start);
  if (elapsed < HOUR) return { unit: "minute", value: Math.max(1, Math.floor(elapsed / 60_000)) };
  if (elapsed < DAY) return { unit: "hour", value: Math.floor(elapsed / HOUR) };
  return { unit: "day", value: Math.floor(elapsed / DAY) };
}

export function waitedLabel(since: string | undefined, now: number, t: Translate) {
  const waited = waitedFor(since, now);
  if (!waited) return "";
  const { unit, value } = waited;
  if (unit === "minute") return t(`${value}분째`, `Waiting ${value} min`);
  if (unit === "hour") return t(`${value}시간째`, `Waiting ${value} h`);
  return t(`${value}일째`, `Waiting ${value} ${value === 1 ? "day" : "days"}`);
}

// A finished session needs the coordinator when one is assigned, it has waited
// past the threshold, no open ledger card covers it, and the coordinator has
// not acted on its current state (a message or a judgment on this excerpt).
// The coordinator's own session is never flagged.
export function needsCoordinator(input: { coordinator: string | null; sessionId?: string; waitingSince?: string; now: number; thresholdHours: number;
  covered: boolean; coordinatorTouched: boolean }) {
  if (!input.coordinator || input.sessionId === input.coordinator || input.covered || input.coordinatorTouched) return false;
  const start = input.waitingSince ? Date.parse(input.waitingSince) : NaN;
  return Number.isFinite(start) && input.now - start >= input.thresholdHours * HOUR;
}
