import { describe, expect, test } from "bun:test";
import { fitInputHeight, maxInputHeight, measureTextareaContent, verticalChrome } from "../client/auto-grow";

describe("auto-grow input height", () => {
  test("an empty or short text keeps the minimum height", () => {
    expect(fitInputHeight({ content: 0, min: 64, max: 480 })).toEqual({ height: 64, scrolls: false });
    expect(fitInputHeight({ content: 40, min: 64, max: 480 })).toEqual({ height: 64, scrolls: false });
  });

  test("the height follows the content between the minimum and the cap, and shrinks again", () => {
    expect(fitInputHeight({ content: 200.2, min: 64, max: 480 })).toEqual({ height: 201, scrolls: false });
    expect(fitInputHeight({ content: 480, min: 64, max: 480 })).toEqual({ height: 480, scrolls: false });
    expect(fitInputHeight({ content: 90, min: 64, max: 480 }).height).toBe(90);
  });

  test("a text past the cap stops growing and scrolls inside the input", () => {
    expect(fitInputHeight({ content: 481, min: 64, max: 480 })).toEqual({ height: 480, scrolls: true });
    expect(fitInputHeight({ content: 5000, min: 64, max: 480 })).toEqual({ height: 480, scrolls: true });
  });

  test("a cap below the minimum never makes the input smaller than the minimum", () => {
    expect(fitInputHeight({ content: 300, min: 64, max: 20 })).toEqual({ height: 64, scrolls: true });
  });

  test("an unmeasurable content height falls back to the minimum", () => {
    for (const content of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(fitInputHeight({ content, min: 56, max: 400 })).toEqual({ height: 56, scrolls: false });
    }
  });

  test("the cap is a share of the window height and keeps the minimum", () => {
    expect(maxInputHeight(800, 64)).toBe(480);
    expect(maxInputHeight(667, 64)).toBe(400);
    expect(maxInputHeight(50, 64)).toBe(64);
    expect(maxInputHeight(Number.NaN, 64)).toBe(64);
  });

  test("padding and border are added on top of the measured text where the platform leaves them out", () => {
    expect(verticalChrome({ padding: 10, borderWidth: 2 }, true)).toBe(24);
    expect(verticalChrome({ paddingVertical: 8, paddingTop: 12, borderWidth: 1 }, true)).toBe(22);
    expect(verticalChrome({ paddingBottom: 5 }, true)).toBe(5);
    expect(verticalChrome({ padding: 10, borderWidth: 2 }, false)).toBe(4);
    expect(verticalChrome({}, true)).toBe(0);
  });
});

describe("measuring a textarea", () => {
  function fakeTextarea(content: number, scrollTop: number) {
    const style = { height: "120px" };
    const node = {
      style, scrollTop,
      get scrollHeight() { return style.height === "0px" ? content : 120; },
    };
    return node;
  }

  test("reads the content height with the height cleared, then restores height and scroll position", () => {
    const node = fakeTextarea(75, 31);
    expect(measureTextareaContent(node)).toBe(75);
    expect(node.style.height).toBe("120px");
    expect(node.scrollTop).toBe(31);
  });

  test("returns nothing for an element that is not a textarea", () => {
    expect(measureTextareaContent(null)).toBeUndefined();
    expect(measureTextareaContent({})).toBeUndefined();
    expect(measureTextareaContent({ style: {}, scrollHeight: "9" })).toBeUndefined();
  });
});
