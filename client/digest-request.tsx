import { useRpc } from "@getpaseo/plugin/client";
import { useRef, useState, type RefObject } from "react";
import { Text } from "react-native";
import { askDigest } from "../shared/operations";
import type { Theme } from "./controls";
import { digestRequestWaiting, type DigestSubmission } from "./digest-freshness";
import { useBoardLanguage } from "./language";

export type CoordinatorAction = {
  pending: RefObject<boolean>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
};

export function useDigestRequest(coordinator: string | null, configured: boolean, action: CoordinatorAction, refresh: () => void, lastDigestAt?: string) {
  const { t, language } = useBoardLanguage();
  const send = useRpc(askDigest);
  const retry = useRef<{ coordinator: string; language: string; key: string } | null>(null);
  const [feedback, setFeedback] = useState<{ coordinator: string; language: string; error: boolean; text: string } | null>(null);
  const submission = useRef<DigestSubmission | null>(null);
  const [requested, setRequested] = useState<DigestSubmission | null>(null);
  const waiting = digestRequestWaiting(requested, coordinator, lastDigestAt);
  async function request(fromDecisions = false) {
    if (!coordinator || !configured || action.pending.current ||
      (fromDecisions && digestRequestWaiting(submission.current, coordinator, lastDigestAt))) return;
    action.pending.current = true;
    action.setBusy(true);
    setFeedback(null);
    if (retry.current?.coordinator !== coordinator || retry.current.language !== language) {
      retry.current = { coordinator, language, key: "board-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) };
    }
    try {
      const result = await send({ coordinator, language, handleBoardFacts: true, requestKey: retry.current.key });
      if (!result.ok) throw Error(t("전송을 확인하지 못했습니다. 다시 시도해 주세요.", "Delivery was not confirmed. Please retry."));
      retry.current = null;
      submission.current = { coordinator, lastDigestAt };
      setRequested(submission.current);
      refresh();
      setFeedback({ coordinator, language, error: false,
        text: t("다이제스트를 요청했습니다. 코디네이터 세션에서 답을 확인하세요.", "Digest requested. Open the coordinator session to read the response.") });
    } catch (error) {
      setFeedback({ coordinator, language, error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      action.pending.current = false;
      action.setBusy(false);
    }
  }
  return { request, waiting, feedback: feedback?.coordinator === coordinator && feedback.language === language ? feedback : null };
}

export type DigestRequest = ReturnType<typeof useDigestRequest>;
export function DigestFeedback({ feedback, theme }: { feedback: DigestRequest["feedback"]; theme: Theme }) {
  return feedback && <Text selectable accessibilityLiveRegion="polite" style={{ color: feedback.error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
    {feedback.text}
  </Text>;
}
