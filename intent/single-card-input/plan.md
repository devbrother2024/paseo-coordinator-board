# Plan: 카드 입력 하나, 병합 카드 수정 요청, 세션 글의 질문 블록

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 단위

한 브랜치, 한 PR. 커밋은 아래 묶음을 따른다. 묶음마다 시험을 먼저 쓴다.

1. 문서: `intent/single-card-input/` 세 파일, `intent/README.md` 목록.
2. 질문 블록(R15~R20): `shared/question-block.ts`(읽기, 답 줄 채우기), `shared/decision-actions.ts`의 `decision.block`, `server/conversation.ts`(끝의 블록 읽기, 블록만 있는 글의 질문), `server/session-decisions.ts`(카드에 싣기).
3. 받는 쪽에 알리는 값(R5~R7): `server/decision-message.ts`의 `mayBe`, `server/tracked-decisions.ts`의 `headerVersion`.
4. 병합 카드 수정 요청(R9~R14): `shared/pull-change-requests.ts`(RPC, 받는 곳), `server/pull-change-requests.ts`(검사, 전송, 거두기), `server/preferences.ts`(`pullChangeRequests`), `shared/pull-judgments.ts`·`shared/prs.ts`(문 `change-requested`), `shared/merge-card-place.ts`, `index.server.ts`(연결, 최근 결정 기록).
5. 화면(R1~R4, R8, R21): `client/card-input.ts`, `client/tracked-reply-draft.ts`, `client/decision-receipts.ts`, `client/tracked-decisions.tsx`, `client/decision-actions.tsx`, `client/pull-requests.tsx`, `client/inline-receipt.tsx`, `client/board.tsx`.
6. 안내: `README.md`, `OVERVIEW.md`(입력 하나, 수정 요청, 질문 블록 형식), 코디네이터 헌장(`server/lifecycle.ts`) 한 줄, `AGENTS.md`의 근거 줄 번호.

## 순서

2 → 3 → 4 → 5 → 6. 2와 3은 화면 없이 시험으로 닫힌다. 4는 서버 시험으로 닫은 뒤 5에서 화면에 잇는다.

## 검증

- `npm run typecheck`, `npm test`, `npm run package:zip` 뒤 `unzip -tq dist/coordinator-board-<version>.zip`.
- 지어낸 데이터의 웹 미리보기(한·영, 넓은 화면·390px): 결정 카드 입력 하나, 보낸 뒤 접힘과 다시 열림, 병합 카드 수정 요청, 질문 블록 카드.

## 위험과 확인할 것

- 원장 답장의 재시도는 메시지 해시에 묶여 있다. 머리 모양이 바뀌면 변경 전에 대기열에 든 답이 "다른 답"으로 읽혀 멈춘다. `headerVersion`이 없는 기록은 옛 모양으로 만든다(R6).
- 질문만 써서 보낸 원장 카드는 받는 쪽이 카드를 다시 올리지 않으면 보드에 돌아오지 않는다. 접힌 카드가 응답을 보여 주고, README와 헌장에 받는 쪽의 할 일을 적는다. 이미 떠 있는 코디네이터는 새 헌장을 받지 않으므로 README의 안내가 기준이다.
- 입력창 자동 높이 변경은 먼저 병합되어 그 공통 입력을 그대로 쓴다. 일하는 중인 세션 전달 변경도 먼저 병합되어, 수정 요청이 그 판정(`canReceiveBoardInput`, `canChangeQueue`)과 대기열 관리 RPC, 대기 화면을 그대로 쓴다. 이 PR은 판정 함수를 새로 만들지 않고 대기열 종류 `pull`만 더한다.
- 수정 요청을 잘못 보내면 새 커밋이 없는 한 병합 카드가 돌아오지 않는다. **병합 카드 다시 열기**로 사람이 되돌린다.
- `PullGate`에 값이 하나 는다. 화면과 서버는 같은 ZIP으로 함께 바뀐다.
