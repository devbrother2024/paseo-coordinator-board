import { TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useId, useState, type ComponentProps } from "react";
import { Platform } from "react-native";
import { Button } from "./controls";
import { isSendShortcut, sendModifier } from "./send-shortcut";

export type SendAction = { disabled: boolean; onPress: () => void };

const modifier = Platform.OS === "web" && typeof navigator !== "undefined" ? sendModifier(navigator.platform) : null;

export function SendTextInput({ send, ...props }: ComponentProps<typeof TextInput> & { send: SendAction }) {
  const input = <TextInput {...props} />;
  if (!modifier) return input;
  return <div style={{ display: "flex", flexDirection: "column" }} onKeyDownCapture={event => {
    if (event.defaultPrevented || !isSendShortcut(event.nativeEvent, modifier)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !send.disabled) send.onPress();
  }}>{input}</div>;
}

export function SendButton({ send, label, accessibilityLabel = label, ...props }:
  Omit<ComponentProps<typeof Button>, keyof SendAction> & { send: SendAction }) {
  const hintId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showHint = hovered || focused;
  useEffect(() => {
    if (!showHint) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHovered(false);
        setFocused(false);
      }
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [showHint]);

  const button = <Button {...props} {...send} label={label} accessibilityLabel={accessibilityLabel}
    describedBy={modifier ? hintId : undefined} />;
  if (!modifier) return button;
  const { colors } = props.theme;
  return <div style={{ position: "relative", display: "inline-flex", maxWidth: "100%" }}
    onPointerEnter={event => setHovered(event.pointerType === "mouse" || event.pointerType === "pen")}
    onPointerLeave={() => setHovered(false)}
    onFocus={event => setFocused(event.target.matches(":focus-visible"))}
    onBlur={() => setFocused(false)}>
    {button}
    <span id={hintId} role="tooltip" hidden={!showHint} style={{
      position: "absolute", bottom: "100%", left: 0, zIndex: 1, marginBottom: 3,
      whiteSpace: "nowrap", padding: "3px 7px", borderRadius: 5, fontSize: 12,
      color: colors.foreground, backgroundColor: colors.surface0, border: "1px solid " + colors.border,
    }}>{modifier === "Meta" ? "⌘+Enter" : "Ctrl+Enter"}</span>
  </div>;
}
