# Plan: 처리됐다는 근거 없이는 세션 대화 카드가 사라지지 않게

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 단위

한 브랜치, 한 PR(0.6.0에 넣음). 묶음마다 시험을 먼저 쓴다.

1. 문서: 이 폴더의 세 파일, `intent/README.md` 목록.
2. 판정(R1~R2, R5~R9): `server/open-questions.ts`, `server/turn-question.ts`, `server/conversation.ts`(발췌 `events`, 분류, 앞쪽 읽기).
3. 기록과 원장(R3, R4, R10): `server/preferences.ts`(`raisedQuestions`, `closedQuestions`), `index.server.ts`(원장 질문, 기록 갱신, 끝난 세션 카드, RPC), `shared/kept-question.ts`, `server/session-decisions.ts`, `server/decisions.ts`, `server/board-sessions.ts`.
4. 화면(R11): `shared/contract.ts`의 `keptQuestion`, `client/kept-question.ts`, `client/decision-actions.tsx`, `client/board.tsx`.
5. 안내: `README.md`, `OVERVIEW.md`.

## 순서

2 → 3 → 4 → 5. 2와 3은 시험으로 닫고, 4에서 화면에 잇는다.

## 검증

- `npm run typecheck`, `npm test`, `npm run package:zip` 뒤 `unzip -tq dist/coordinator-board-<version>.zip`.
- 판정을 일부러 망가뜨린 변형(사람의 다른 글로 닫힘, 기록 무시)에서 시험이 실패하는지 확인.
- 화면 확인은 지어낸 예시 데이터로, 코디네이터가 화면 차례를 허락한 뒤에만 한다.

## 위험과 확인할 것

- 질문 판정이 잘못 잡은 글(질문이 아닌데 질문으로 본 글)도 처리 근거가 나올 때까지 남는다. 불변식이 그쪽을 택한다. **처리됨으로 닫기**로 닫는다.
- 이 변경 전에 보드에서 답한 질문이 아직 대화 범위 안에 있으면, 영수증이 남아 있어 보드 답장으로 닫힌다. 영수증이 없는 옛 답(사람이 세션에 직접 쓴 답)은 "답했을 수 있음"으로 남는다.
- 스냅샷마다 기록을 질문 단위로 병합해 저장한다. 바뀐 것이 없으면 쓰지 않고, 저장이 실패해도 보드는 계속 보인다.
- 열린 질문은 개수로 자르지 않는다. 기록이 커지는 것은 처리 근거로만 줄어든다.
- 끝난 세션 카드는 보드가 찾지 못한 세션 모두에 생긴다. 호스트가 잠시 끊긴 원격 세션도 "세션 끝남 · 미처리"로 보일 수 있다(문구에 "찾을 수 없어"를 함께 쓴다).
