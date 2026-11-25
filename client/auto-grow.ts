// The height of a multi-line input that grows with its text. The component in auto-grow-input.tsx only measures and applies these numbers.

export const MAX_INPUT_SHARE = 0.6;

export function maxInputHeight(windowHeight: number, min: number) {
  const share = Number.isFinite(windowHeight) ? Math.floor(windowHeight * MAX_INPUT_SHARE) : 0;
  return Math.max(min, share);
}

// Picks the shown height from the text height. Above the cap the input stops growing and scrolls inside.
export function fitInputHeight({ content, min, max }: { content: number; min: number; max: number }) {
  const wanted = Number.isFinite(content) && content > 0 ? Math.ceil(content) : 0;
  const cap = Math.max(min, max);
  const height = Math.min(Math.max(wanted, min), cap);
  return { height, scrolls: wanted > height };
}

type Chrome = { padding?: unknown; paddingVertical?: unknown; paddingTop?: unknown; paddingBottom?: unknown; borderWidth?: unknown };

const px = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

// What the height has to add to the measured text. A browser textarea reports its scroll height with padding but without the border.
// A native text input reports the text alone.
export function verticalChrome(style: Chrome, paddingCounted: boolean) {
  const top = style.paddingTop ?? style.paddingVertical ?? style.padding;
  const bottom = style.paddingBottom ?? style.paddingVertical ?? style.padding;
  return (paddingCounted ? px(top) + px(bottom) : 0) + px(style.borderWidth) * 2;
}

type TextareaLike = { style: { height: string }; scrollTop: number; scrollHeight: number };

function isTextarea(node: unknown): node is TextareaLike {
  const candidate = node as Partial<TextareaLike> | null;
  return !!candidate && typeof candidate === "object" && typeof candidate.scrollHeight === "number"
    && typeof candidate.scrollTop === "number" && !!candidate.style && typeof candidate.style === "object";
}

// A textarea never reports less than its own height, so the height is cleared for the read and put back right away (before any paint).
// Clearing it resets the scroll position, which would otherwise jump while typing in a text taller than the cap.
export function measureTextareaContent(node: unknown) {
  if (!isTextarea(node)) return undefined;
  const { height } = node.style;
  const top = node.scrollTop;
  node.style.height = "0px";
  const content = node.scrollHeight;
  node.style.height = height;
  node.scrollTop = top;
  return content;
}
