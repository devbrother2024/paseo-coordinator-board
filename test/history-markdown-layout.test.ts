import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Layout cannot be run in these tests, so the structure that keeps list text from collapsing is checked in the source.
const source = readFileSync(new URL("../client/history-markdown.tsx", import.meta.url), "utf8");

test("the markdown root fills the width its parent gives, even under alignItems flex-start", () => {
  const root = /return\s*<View style=\{\{([^}]*)\}\}>\{blocks\(tokens,true\)\}<\/View>/.exec(source);
  expect(root).not.toBeNull();
  expect(root![1]).toContain('alignSelf:"stretch"');
});

test("a list item's text column keeps flex:1 and minWidth:0 beside its marker", () => {
  expect(source).toMatch(/flexDirection:"row",gap:6\}\}>\s*<Text style=\{base\}>\{list\.ordered/);
  expect(source).toContain("flex:1,minWidth:0");
});
