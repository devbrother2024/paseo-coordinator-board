# Plan: 교체 뒤 인계 시작 지시와 옛 코디네이터 보관

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #57)

## 단위

한 PR(세션 경로).

1. 시험 먼저: `test/coordinator-bootstrap.test.ts`(프롬프트 조립, 파일 읽기·정리, 은퇴 판정, 교체 통합, 보관, 읽기 예외).
2. `server/coordinator-bootstrap.ts`: 순수 판정과 파일 읽기.
3. `server/lifecycle.ts`: 생성 요청에 프롬프트, 카드 수 시간 제한, `retired`·`archiveRetired`.
4. `server/coordinator.ts`: 옛 코디네이터 읽기 예외.
5. `shared/operations.ts`, `server/operations.ts`, `index.server.ts`: RPC 두 개와 카드 수 공급.
6. `client/retired-coordinator.tsx`, `client/operations.tsx`, `client/coordinator-replace.tsx`: 화면.
7. `README.md`, `OVERVIEW.md`, `AGENTS.md`(규칙과 근거 줄), `intent/README.md` 목록.

## 순서

1 → 2~5(시험 통과) → 6 → 7.

## 검증

- `npm ci`, `npm run typecheck`, `npm test`, `npm run package:zip`, `unzip -tq dist/coordinator-board-<version>.zip`.
- 화면: 지어낸 데이터로 넓은 화면과 390px, 한국어와 영어.
- 바뀐 한국어 문서에 em dash가 없다.

## 위험과 확인할 것

- 첫 프롬프트는 받는 세션 기록에 사람 글과 같은 자리에 남는다. 머리말과 "승인이 아니다" 줄로 구분한다.
- 카드 수를 세는 스냅샷 읽기가 느리면 교체가 최대 10초 늦어진다.
- 읽기 예외는 옛 코디네이터 대화(사람의 지시 포함)를 새 코디네이터에게 보인다. 사람이 교체한 같은 역할의 세션이고, 바로 앞 하나로 제한한다.
