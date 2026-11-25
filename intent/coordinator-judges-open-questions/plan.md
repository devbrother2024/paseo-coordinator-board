# Plan: 남은 질문이 처리됐는지 사람이 아니라 코디네이터가 판단

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 단위

한 브랜치, 한 PR(0.6.0에 넣음). 시험을 먼저 쓴다.

1. 문서: 이 폴더, `intent/README.md` 목록.
2. 판정과 저장(R2, R5, R6): `server/open-questions.ts`, `server/preferences.ts`, `server/conversation.ts`.
3. 코디네이터 기능(R3, R4): `server/question-judgments.ts`, `index.server.ts`(도구 목록, 알림, 이력).
4. 화면(R7): `shared/contract.ts`, `client/kept-question.ts`, `client/decision-actions.tsx`.
5. 안내: `README.md`, `OVERVIEW.md`.

## 검증

- `npm run typecheck`, `npm test`(계약 스냅샷 포함), `npm run package:zip` 뒤 `unzip -tq`.
- 화면 확인은 지어낸 데이터로, 코디네이터가 허락한 뒤에만.

## 위험

- 판단 필요 알림이 코디네이터 대화에 쌓일 수 있다. 질문마다 한 번만, 여러 질문은 한 글로 묶는다.
- 새 action이 생기면 안내 도구 개정이 바뀌어 운영 중인 대화에 안내 도구를 읽으라는 알림이 한 번 붙는다(설계된 동작).
