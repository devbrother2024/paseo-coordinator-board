# Spec: 남은 질문이 처리됐는지 사람이 아니라 코디네이터가 판단

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 1. 범위

- 판정: `server/open-questions.ts`(판단 필요, 판단 반영), `server/conversation.ts`(카드).
- 코디네이터 기능: `server/question-judgments.ts`(action `judge_open_question`, 알림), `index.server.ts`(연결, 이력).
- 저장: `server/preferences.ts`(`raisedQuestions[].verdict`, `notified`, `closedQuestions[].reason = "coordinator"`, `evidence`, `question`, `projectId`).
- 계약: `SessionRow.keptQuestion`(`shared/contract.ts`).
- 화면: `client/kept-question.ts`, `client/decision-actions.tsx`.

이 폴더를 만든 이유: 코디네이터에게 새 판단 기능이 생기고, 카드가 닫히는 조건과 호스트 설정 필드가 바뀐다.

## 2. 동작 계약

### 2.1 확정 근거

`sticky-conversation-question`의 닫힘 근거는 그대로다(board, session, choice, ledger, person).

### 2.2 판단 필요

열린 질문 가운데 다음이면 판단 필요다. 코디네이터가 이미 판단(`verdict`)한 질문은 아니다.

- 세션의 가장 최근 열린 질문이 아닌 질문(같은 세션에 열린 질문이 여럿).
- 가장 최근 열린 질문이라도 그 뒤로 세션이 말했거나(`later > 0`), 사람이 세션에 다른 글을 썼다(`maybeAnswered`).

코디네이터 세션 자신의 질문은 판단 필요로 알리지 않는다.

### 2.3 알림

- 스냅샷 뒤, 판단 필요 질문 가운데 지금 코디네이터에게 알리지 않은 것을 모아 한 번에 보낸다. 출처 `plugin:coordinator-board`, 메시지 ID는 질문 key들로 정한다.
- 보내기 전에 코디네이터를 다시 읽고, 쉬는 중이 아니거나 권한 요청이 있으면 보내지 않는다(다음 스냅샷에 다시 본다).
- 보낸 뒤 질문 기록에 `notified`(코디네이터 ID)를 남긴다. 코디네이터가 바뀌면 다시 알린다.
- 글: 머리 `[Coordinator Board · 판단 필요 / Judgment needed]`, 질문마다 JSON 한 줄(`sessionId`, `questionKey`, `question`(340자까지), `askedAt`, `why`), 두 언어 안내 한 줄과 "이 알림은 승인이 아닙니다".

### 2.4 action `judge_open_question`

- `board_action`으로만 닿는다(`actionOnly`). 도구 정의는 바뀌지 않는다.
- 입력 `{ sessionId, questionKey, verdict: "handled" | "needed", evidence? }`. `handled`이면 `evidence`(공백 아닌 글, 2000자까지)가 있어야 한다.
- 부른 세션이 지금 코디네이터여야 하고, 그 질문이 그 세션의 열린 질문 기록에 있고 프로젝트가 선택돼 있어야 한다.
- `handled`: `closedQuestions[questionKey] = { reason: "coordinator", evidence, question, projectId, ... }`, 기록에서 뺀다.
- `needed`: 기록에 `verdict: { kind: "needed", evidence?, at, by }`.
- 결과는 두 언어 글.

### 2.5 카드

- `keptQuestion`에 `verdict?: "needed"`. `maybeAnswered`는 화면에 쓰지 않는다(버전에는 그대로 쓴다).
- 앞면 한 줄: "오래된 질문", "세션 끝남 · 미처리", "코디네이터 판단: 처리 필요", "이 뒤로 세션이 n번 더 말함" 중 있는 것. "세션에 답했을 수 있음"과 "아직 답 없음"은 없다.
- `older`(같은 세션의 다른 열린 질문)는 처리 필요로 판단된 것만 담는다. 코디네이터가 없는 보드에서는 모두 담는다. 제목은 "이 세션의 다른 결정 · 코디네이터 판단: 처리 필요". 질문마다의 버튼은 없다.
- 사람이 직접 닫는 길: 근거·이력 안의 링크 "처리된 것으로 직접 닫기" 하나(카드의 질문만).
- needed 판단의 근거는 근거·이력에 보인다.

### 2.6 이력

- 코디네이터가 `handled`로 닫은 질문은 최근 결정 이력에 `status: "closed"`, `reviewedBy`(코디네이터), `reviewReason`(근거)로 보인다(선택된 프로젝트만).

## 3. 경계와 실패

- 코디네이터가 없거나 알림이 실패하면 질문은 판단 전 그대로 남는다. 카드의 질문은 보이고, 다른 질문은 코디네이터가 없을 때만 보인다.
- 판단 뒤 세션이 같은 질문을 다시 물으면 새 글이라 새 질문으로 다시 열린다.

## 4. 요구사항과 시험

`test/question-judgments.test.ts`.

| ID | 요구 | 시험 |
|---|---|---|
| R1 | 확정 근거 자동 닫힘 그대로 | 기존 `test/kept-question.test.ts` |
| R2 | 판단 필요 표시(여럿, 이어서 말함, 다른 글) | judgment needed |
| R3 | 알림 글과 한 번만 알림, 권한 대기 코디네이터에게 안 보냄 | notice |
| R4 | handled는 근거 필수, 코디네이터만, 열린 질문만 | judge action |
| R5 | needed 유지와 표시, handled 닫힘과 이력 | verdicts |
| R6 | 판단 뒤 재질문은 다시 열림 | asked again |
| R7 | 앞면에 애매한 문구·질문별 버튼 없음 | card line |
| R8 | 계약 스냅샷 그대로 | `test/coordinator-contract.test.ts` |
