# Plan: 사람이 답하기 전까지 세션 대화 카드가 사라지지 않게

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 단위

한 브랜치, 한 PR. 묶음마다 시험을 먼저 쓴다.

1. 문서: 이 폴더의 세 파일, `intent/README.md` 목록.
2. 판정(R1~R3, R5~R9): `server/conversation.ts`(`since`, `openQuestion`, 더 읽기), `server/session-decisions.ts`(질문 글에서 카드 만들기, 버전), `server/decisions.ts`(재검증).
3. 원장과 닫기(R4, R8, R11): `shared/kept-question.ts`(RPC), `server/preferences.ts`(`closedQuestions`), `index.server.ts`(원장 뒤 내리기, RPC 처리), `server/board-sessions.ts`(원격 판정에 닫은 질문 반영).
4. 화면(R10): `client/kept-question.ts`, `client/decision-actions.tsx`, `shared/contract.ts`의 `keptQuestion`.
5. 안내: `README.md`, `OVERVIEW.md`(남는 질문, 닫히는 조건, 해결 줄).

## 순서

2 → 3 → 4 → 5. 2와 3은 시험으로 닫고, 4에서 화면에 잇는다.

## 검증

- `npm run typecheck`, `npm test`, `npm run package:zip` 뒤 `unzip -tq dist/coordinator-board-<version>.zip`.
- 화면 확인은 지어낸 예시 데이터로, 코디네이터가 화면 차례를 허락한 뒤에만 한다.

## 위험과 확인할 것

- 더 읽기는 사람이 오래 답하지 않은 세션마다 읽기를 늘린다. 조건(질문도 사람 입력도 없을 때만)과 상한(두 번, 31개 글, 24시간)으로 묶고, 결과는 지금처럼 활동 시각 기준으로 캐시된다.
- 남는 카드의 버전이 발췌 대신 질문 글로 정해진다. 질문이 마지막 글이던 카드가 남는 카드로 바뀌는 순간 버전이 한 번 바뀐다. 그 사이에 사람이 답했다면 사람의 입력이 있어 남는 카드가 되지 않는다.
- 같은 세션을 가리키는 원장 카드는 질문과 상관없는 카드여도 남는 카드를 내린다. 원장에 그 세션의 다음 할 일이 이미 있다는 뜻으로 본다.
