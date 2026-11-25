import type { PluginServerContext } from "@getpaseo/plugin/server";
import { requestRecommendation } from "../shared/recommendation";
import type { DecisionSender } from "./decisions";

export function recommendationPrompt(sessionId: string, language: "ko" | "en") {
  const target = JSON.stringify({ sessionId });
  return language === "en"
    ? `Review only this decision card: ${target}. Use read_board_conversation to check the latest source. If a person must decide, use classify_board_conversation to save content.question as one concrete question. Propose one ready-to-send reply in content.recommendation with a brief recommendationReason grounded in the evidence or an established preference. Label it as a proposal, never as the person's decision. If essential information is missing, record exactly what is needed in content.needsInput. If the question names options by label only, such as "B", put every option with what it does in content.options so the card can be decided on the board alone. Don't invent a title, preference, approval or a fact. If the question has already been resolved, classify the evidence accordingly. This request only updates the card. Do not message the worker or carry out the proposed action.`
    : `결정 카드 한 건만 검토해 주세요. 대상은 ${target}입니다. read_board_conversation으로 최신 발췌를 읽고, 사람 결정이 필요하면 classify_board_conversation의 content.question에 결정할 질문 한 문장을 기록하세요. 대화 근거나 이미 정한 기준으로 추천할 수 있으면 content.recommendation에 바로 보낼 완결된 답장 한 개, recommendationReason에 그 이유를 짧게 적으세요. 사용자가 이미 결정했다고 표현하지 마세요. 질문이 "B"처럼 이름표만 가리키면 모든 선택지와 고르면 달라지는 점을 content.options에 옮겨 보드만 보고 정할 수 있게 하세요. 필수 정보가 부족하면 content.needsInput에 무엇을 알려줘야 하는지 적고 제목·취향·승인·사실을 지어내지 마세요. 이미 해결됐다면 근거에 맞게 분류하세요. 이번에는 이 카드만 갱신하고 작업자에게 메시지를 보내거나 추천한 행동을 실행하지 마세요.`;
}

export function registerRecommendation(server: PluginServerContext, decisions: DecisionSender) {
  server.handle(requestRecommendation, (input, { paseo }) => decisions.send(paseo, {
    projectId: input.projectId,
    sessionId: input.sessionId,
    version: input.version,
    requestKey: input.requestKey,
    recipientId: input.coordinator,
    action: "coordinate",
    text: recommendationPrompt(input.sessionId, input.language),
  }));
}
