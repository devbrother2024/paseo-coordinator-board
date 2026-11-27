import { expect, test } from "bun:test";
import { markdownTail } from "../shared/markdown-tail";

const table = "| # | 파일 | 길이 | 크기 |\n|---|---|---|---|\n" + [1, 2, 3, 4].map(n => `| ${n} | 0${n}_clip.mp4 | 1:3${n} | 26${n}.1 MB |`).join("\n");

test("a short message is kept as it is", () => {
  expect(markdownTail("short", 100)).toBe("short");
});

test("the end of a message starts at a whole line", () => {
  const text = "first line that is long\nsecond line\nthird line";
  expect(markdownTail(text, 20)).toBe("third line");
  expect(markdownTail(text, 23)).toBe("second line\nthird line");
});

test("a cut inside a table keeps the table's header in front of the kept rows", () => {
  // 2026-11-26: the cut fell in the header row, so the context began "파일 | 길이 | 크기 |" and the table broke.
  const text = "Intro paragraph.\n\n" + table + "\n\nFolder: out/";
  const header = "| # | 파일 | 길이 | 크기 |\n|---|---|---|---|\n";
  for (const at of [text.indexOf("파일"), text.indexOf("| 2 |") + 3]) {
    const kept = markdownTail(text, text.length - at);
    expect(kept.length).toBeLessThanOrEqual(text.length - at);
    expect(kept.startsWith(header)).toBe(true);
    expect(kept.endsWith("| 4 | 04_clip.mp4 | 1:34 | 264.1 MB |\n\nFolder: out/")).toBe(true);
  }
  // The limit holds: when the head and a row do not both fit, the rows go, never the head alone or a headless row.
  for (let at = text.indexOf("| # |"); at < text.indexOf("Folder"); at += 7) {
    const kept = markdownTail(text, text.length - at);
    expect(kept.length).toBeLessThanOrEqual(text.length - at);
    const rows = kept.split("\n");
    if (rows[0].startsWith("|")) expect(rows[1]).toBe("|---|---|---|---|");
  }
  // A cut right at the table's first row keeps it whole.
  expect(markdownTail(text, text.length - text.indexOf("| # |"))).toBe(table + "\n\nFolder: out/");
  // Rows without a separator are not a table: the rows before the cut are left out.
  const loose = "Intro.\n| a | b |\n| c | d |\n| e | f |\nEnd";
  expect(markdownTail(loose, loose.length - loose.indexOf("c |"))).toBe("End");
});
