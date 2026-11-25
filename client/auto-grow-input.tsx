import { TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { Platform, StyleSheet, useWindowDimensions } from "react-native";
import { fitInputHeight, maxInputHeight, measureTextareaContent, verticalChrome } from "./auto-grow";
import { SendTextInput, type SendAction } from "./send-input";

const web = Platform.OS === "web";
const DEFAULT_MIN_HEIGHT = 56;

type Props = ComponentProps<typeof TextInput> & { send?: SendAction; onOverflowChange?: (overflows: boolean | undefined) => void };

// A multi-line input that is as tall as its text, from the style's minHeight up to a share of the window, then scrolls inside.
// A single-line input (multiline off) is passed through untouched.
export function AutoGrowInput({ send, style, multiline, value, onLayout, onContentSizeChange, onOverflowChange, ...props }: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const input = useRef<unknown>(null);
  const [content, setContent] = useState<number>();
  const [width, setWidth] = useState<number>();
  const flat = StyleSheet.flatten(style) ?? {};
  const min = typeof flat.minHeight === "number" ? flat.minHeight : DEFAULT_MIN_HEIGHT;

  const measure = useCallback(() => {
    if (!web || !multiline) return;
    const next = measureTextareaContent(input.current);
    if (next !== undefined) setContent(next);
  }, [multiline]);
  // The text, the width (line breaks move with it), the minimum height and the font all change what fits.
  useLayoutEffect(measure, [measure, value, width, min, flat.fontSize, flat.lineHeight]);
  // A web font that arrives after the first measure changes the line breaks without any prop changing.
  useEffect(() => {
    if (!web || !multiline || typeof document === "undefined" || !document.fonts) return;
    document.fonts.addEventListener("loadingdone", measure);
    return () => document.fonts.removeEventListener("loadingdone", measure);
  }, [measure, multiline]);

  const fit = content === undefined ? undefined : fitInputHeight({ content: content + verticalChrome(flat, !web), min, max: maxInputHeight(windowHeight, min) });
  // Tells the owner whether the text is taller than the input can grow, so it can ask for a read confirmation only then.
  const overflows = multiline ? fit?.scrolls : false;
  useEffect(() => { onOverflowChange?.(overflows); }, [overflows, onOverflowChange]);
  const grown = !multiline ? style : [style, { minHeight: min, height: fit?.height },
    web ? { resize: "none", overflowY: fit?.scrolls ? "auto" : "hidden" } as object : null];
  const fields = {
    ...props, value, multiline, style: grown, ref: input as never,
    onLayout: (event: Parameters<NonNullable<Props["onLayout"]>>[0]) => {
      setWidth(event.nativeEvent.layout.width);
      onLayout?.(event);
    },
    onContentSizeChange: (event: Parameters<NonNullable<Props["onContentSizeChange"]>>[0]) => {
      if (!web) setContent(event.nativeEvent.contentSize.height);
      onContentSizeChange?.(event);
    },
  };
  return send ? <SendTextInput send={send} {...fields} /> : <TextInput {...fields} />;
}
