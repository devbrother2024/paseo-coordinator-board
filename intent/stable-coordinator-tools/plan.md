# Plan: 고정된 코디네이터 도구 계약과 확장 길

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #62)

## 단위

한 PR이다. 기능 커밋 하나에, `next` 병합 커밋과 문서 상태 커밋이 따른다.

1. 시험 먼저: `test/coordinator-tools.test.ts`를 계약 기준 판정과 한 번 알림으로 고치고, `test/board-guide.test.ts`와 `test/coordinator-contract.test.ts`를 더한다.
2. `shared/coordinator-contract.ts`(계약 번호, 도구 이름), `shared/coordinator-tools.ts`(기록 형식, 판정, 알림 조건).
3. `server/board-guide.ts`(기능 목록, `board_action`, `read_board_guide`, 안내 판본), `server/coordinator-tools.ts`(이름과 입력 형식만 보는 지문, 기록, 알림, 압축 확인), `server/coordinator.ts`(두 도구 붙이기), `server/preferences.ts`(기록 항목), `index.server.ts`(코디네이터 턴이 끝날 때 압축 확인).
4. 기존 도구 일곱 개는 설명, 입력 형식, 실행 함수를 모두 그대로 둔다(설명을 줄였다가 설계 검토에서 되돌렸다). `server/digest.ts`의 완료 판정이 `board_action` 경유 호출을 세게 한다(구현 중 발견). 실행기 판정을 바탕 구현 기준으로 바꾼다(설계 검토 반영).
5. `client/coordinator-tools.ts`, `client/stale-coordinator-tools.tsx`의 안내 문구와 버튼 순서.
6. 계약 스냅샷 `test/fixtures/coordinator-contract.json`. 병합 전에 두 도구의 `contract` 항목을 빼면서 계약 1의 스냅샷을 한 번 다시 만들었다(아직 배포되지 않은 계약이라 번호는 그대로).
7. 문서: `README.md`, `OVERVIEW.md`, `AGENTS.md`, 코디네이터 헌장과 예시 문서의 안내 한 줄, `intent/README.md` 목록.

## 순서

시험(1)을 먼저 쓰고 실패를 확인한 뒤 2~6을 구현한다. 문서는 마지막이다.

## 검증

- `npm ci`, `npm run typecheck`, `npm test`, `npm run package:zip`과 ZIP 무결성 검사.
- 화면 안내: 지어낸 예시 데이터로 넓은 화면과 390px, 한국어와 영어.
- 설치본에는 적용하지 않는다. 운영 대화에서의 동작은 병합 뒤 유지관리자 호스트에서 확인한다.

## 위험과 확인할 것

- 도구 설명은 운영 중인 대화에 닿지 않는다(그 대화는 받았던 문구를 본다). 문구 변경은 알리지 않으므로, 꼭 닿아야 하는 변경은 `accepts`나 `usage`와 함께 낸다.
- 이번 변경 자체가 도구를 두 개 더하므로 옛 기록의 대화는 한 번 `stale`이 된다. 코디네이터가 안내 도구를 읽으면 풀린다. 그 전까지 화면 안내가 보인다.
- 확인한 사실은 Claude Code 한 버전에서 본 것이다. 실행기가 클라이언트 검사를 넣거나 새 도구를 기존 대화에 알리지 않게 바뀌면, 그 대화는 압축이나 교체가 필요해진다. `board_action`의 입력은 열린 객체라 어느 쪽에서도 정의를 어기지 않는다.
