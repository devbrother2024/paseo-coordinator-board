import { expect, test } from "bun:test";
import { canResumeHeldReply, parallelEligible, waitsForIdle } from "../shared/busy-delivery";

test("parallel review opens for unsupported providers or at the configured wait boundary", () => {
  const at = "2026-01-01T00:00:00.000Z", start = Date.parse(at);
  expect(parallelEligible(at,"codex",10,start + 599999)).toBe(false);
  expect(parallelEligible(at,"claude",10,start + 600000)).toBe(true);
  expect(parallelEligible(at,"custom",30,start)).toBe(true);
  expect(parallelEligible(at,undefined,30,start)).toBe(false);
});

test("only a standalone idle marker in the conversation applies", () => {
  expect(waitsForIdle("deliverWhenIdle: true\nWhich layout?")).toBe(true);
  for (const example of ["> deliverWhenIdle: true","use deliverWhenIdle: true","    deliverWhenIdle: true",
    "```yaml\ndeliverWhenIdle: true\n```","~~~yaml\ndeliverWhenIdle: true","deliverWhenIdle: false","DeliverWhenIdle: true","deliverWhenIdle: True","deliverWhenIdle: true."]) {
    expect(waitsForIdle(example)).toBe(false);
  }
});

test("resume is offered only for a held reply with a live original session", () => {
  expect(canResumeHeldReply({parallel:"held", stopped:false, originState:"live"})).toBe(true);
  for (const originState of ["ended","unknown"] as const) {
    expect(canResumeHeldReply({parallel:"held", stopped:false, originState})).toBe(false);
  }
  expect(canResumeHeldReply({parallel:"held", stopped:true, originState:"live"})).toBe(false);
  expect(canResumeHeldReply({parallel:"resumed", stopped:false, originState:"live"})).toBe(false);
});
