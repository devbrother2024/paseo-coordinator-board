import { TextInput } from "@getpaseo/plugin/client/ui";
import type { ComponentProps } from "react";
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
  const hint = modifier === "Meta" ? "⌘+Enter" : "Ctrl+Enter";
  return <Button {...props} {...send} accessibilityLabel={accessibilityLabel} label={modifier ? label + "  ·  " + hint : label} />;
}
