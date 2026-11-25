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
- 세션이 끝났거나 보드가 찾지 못한다(`session-ended`).

코디네이터 세션 자신의 질문은 판단 필요로 알리지 않는다.

### 2.3 알림

- 스냅샷 뒤, 판단 필요 질문 가운데 알릴 때가 된 것을 모아 보낸다. 한 번에 한 글만, 글 사이는 5분 이상(`judgmentNotice`에 마지막 알림 시각). 한 글에 질문 20개까지, 세션마다 돌아가며 고르고 한 세션은 한 글에 5개까지다. 한 세션은 30분에 한 글에만 들어간다(세션 기록의 `noticedAt`). 그래서 한 세션이 질문을 아무리 쌓아도 코디네이터 차례를 시간당 2번까지만 깨운다. 첫 알림을 다시 알림보다 먼저 보낸다. 출처 `plugin:coordinator-board`, 메시지 ID는 질문 key들과 시도 시각으로 정한다.
- 글마다 보내기 직전에 코디네이터를 다시 읽는다. 앞 글이 시작한 차례가 권한 요청을 기다리면 그 뒤 글은 보내지 않는다.
- 보내기 전에 코디네이터를 다시 읽고, 쉬는 중이 아니거나 권한 요청이 있으면 보내지 않는다(다음 스냅샷에 다시 본다).
- 보내기 전에 질문 기록에 `notified`(코디네이터 ID)와 `notifiedAt`(시도 시각)을 남긴다. 전송이 실패해도 같은 알림을 다시 보내지 않는다(출처 붙인 전송의 자동 재시도 금지).
- 판단이 오지 않은 질문은 머리 `[Coordinator Board · 아직 판단 안 됨 / Still not judged]`의 새 알림으로 다시 알린다. 첫 시도 30분 뒤, 그 뒤로는 앞 간격의 두 배씩(60분, 120분, …), 8시간을 넘지 않는다(질문별 `notices`). 재시도가 아니라 새 알림이다.
- 코디네이터가 바뀌면 새 코디네이터에게 처음 알림으로 보낸다.
- 글: 머리 `[Coordinator Board · 판단 필요 / Judgment needed]`, 질문마다 JSON 한 줄(`sessionId`, `questionKey`, `why`, `askedAt`, `seq`: 보드가 만든 값만), 두 언어 안내 한 줄과 "이 알림은 승인이 아닙니다". 작업 세션이 쓴 질문 글은 싣지 않는다. 출처 붙인 알림이 코디네이터 차례를 시작하므로, 세션 글이 보드의 말처럼 들어가지 않게 하기 위해서다. 코디네이터는 세션 기록(`read_board_conversation` 또는 세션 로그의 `seq` 위치)에서 질문을 근거로 읽는다.

### 2.4 action `judge_open_question`

- `board_action`으로만 닿는다(`actionOnly`). 도구 정의는 바뀌지 않는다.
- 입력 `{ sessionId, questionKey, verdict: "handled" | "needed", evidence?, todo? }`. `todo`는 needed 판단에 카드가 보일 할 일(1~80자). `handled`이면 `evidence`(공백을 빼고 10자 이상, 2000자까지, 어느 글·답·카드인지)가 있어야 한다.
- 이미 코디네이터 근거로 닫힌 질문에 `handled`를 다시 부르면 성공한다(멱등). `needed`는 열린 질문에만.
- 부른 세션이 지금 코디네이터여야 하고, 그 질문이 그 세션의 열린 질문 기록에 있고 프로젝트가 선택돼 있어야 한다.
- `handled`: `closedQuestions[questionKey] = { reason: "coordinator", evidence, question, projectId, ... }`, 기록에서 뺀다.
- `needed`: 기록에 `verdict: { kind: "needed", evidence?, at, by }`.
- 결과는 두 언어 글.

### 2.5 카드

- `keptQuestion`에 `verdict?: "needed"`. `maybeAnswered`는 화면에 쓰지 않는다(버전에는 그대로 쓴다).
- 앞면 한 줄은 처리 필요 판단에만: "처리 필요 · <할 일>" / "Needs your decision · <todo>". 할 일은 판단의 `todo`(80자까지), 없으면 질문의 첫 줄. 판단 전 카드에는 줄이 없다(보통 결정 카드). 오래됐다는 표시(흐림, "오래된 질문")와 "이 뒤로 세션이 n번 더 말함", "세션 끝남 · 미처리" 줄은 없다. 끝난 세션은 답 입력 대신 안내 문장으로 알린다. 기다린 시간은 머리 줄이 보인다.
- `older`(같은 세션의 다른 열린 질문)는 판단과 상관없이 모두 담는다(개수로 자르지 않음). 카드는 10개를 넘는 것을 "외 n개 더 보기"로 접고, 펼치면 모두 보인다. 사라지는 것은 처리 근거로 닫힌 질문뿐이다. 제목은 "이 세션의 다른 결정". 질문마다의 버튼은 없다.
- 사람이 직접 닫는 길: 근거·이력 안의 링크 "처리된 것으로 직접 닫기" 하나(카드의 질문만).
- needed 판단의 근거는 근거·이력에 보인다.

### 2.6 이력

- 코디네이터가 `handled`로 닫은 질문은 최근 결정 이력에 `status: "closed"`, `reviewedBy`(코디네이터), `reviewReason`(근거)로 보인다(선택된 프로젝트만).

## 3. 경계와 실패

- 코디네이터가 없거나 알림이 실패하면 질문은 판단 전 그대로 남고 카드에 보인다.
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
| R8 | 도구 정의 그대로, 안내 판본만 바뀜(`board_action` 전용 action이 생겨 `guide` 해시가 생김) | `test/coordinator-contract.test.ts` |
