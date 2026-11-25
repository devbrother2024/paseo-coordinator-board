# Plan: 읽기 전용 셸 요청 자동 승인

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 단위

한 PR이다. 커밋은 다음 순서로 나눈다.

1. intent, spec, plan.
2. 분류기가 찾은 읽기 경로 노출(`shellPermissionTargets`), 파서의 `inlineInput` 표시, 응답 함수를 `shared/permission-responder.ts`로 옮김. 동작 변화 없음.
3. 글자 판단(`shared/permission-auto-approve.ts`), 민감한 이름 목록(`guardedWord`), 호스트 확인과 기록(`server/permission-auto-approve.ts`), 훅 연결. 시험을 먼저 쓴다.
4. 설정 화면, 세션 카드의 이력 줄, 스냅샷 항목.
5. README, OVERVIEW, `docs/permission-classification.md`, `AGENTS.md`, 배포 필수 파일 목록.

## 순서

- 시험을 먼저 쓴다: 경계 사례(따옴표 안의 `;`, 헤어닥, `cat .env`, `rg -n x ~/.ssh`, `find / -name id_rsa`, `git log > out.txt`, `ls $(echo …)`)와 이전 분류기를 우회했던 입력을 그대로 넣는다.
- 호스트 확인 시험은 임시 폴더에 실제 파일과 링크를 만들어 돌린다.
- 화면 확인은 지어낸 예시 데이터로 한다.

## 검증

- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run package:zip` 뒤 `unzip -tq dist/coordinator-board-<version>.zip`
- 화면: 넓은 화면과 390px, 한국어와 영어에서 설정 스위치와 안내, 최근 자동 승인 목록, 세션 카드의 이력 줄, 사람에게 온 요청 카드.

## 위험과 확인할 것

- 응답 함수를 옮기면서 사람의 버튼 경로가 바뀌지 않았는지: 기존 `test/pending-requests.test.ts`가 그대로 통과해야 한다.
- 스냅샷 항목은 선택 항목이라 옛 클라이언트와 옛 서버의 조합에서 화면이 깨지지 않아야 한다.
- 실행기의 요청 형식은 Paseo 호스트 버전에 묶여 있다. `@getpaseo/plugin` 버전을 올릴 때 2.4의 표를 호스트 코드에서 다시 확인한다.
- 운영 호스트의 설치본에는 이 PR에서 적용하지 않는다.
