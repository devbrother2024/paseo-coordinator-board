# Plan: intent·spec·plan 구조와 두 승인 경로

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #52)

## 단위

한 PR(세션 경로), 커밋 하나.

1. `intent/README.md`: 규칙 전문.
2. `intent/intent-workflow/`: 이 구조 자체의 intent·spec·plan(본보기).
3. 루트 `AGENTS.md`: "구현 전 산출물(`intent/`)" 절.
4. `CONTRIBUTING.md`: 외부 기여자 흐름.
5. `.github/pull_request_template.md`: Intent 칸.
6. `README.md`, `OVERVIEW.md`: 같은 내용의 기여 안내 한 줄.

## 순서

문서만 바꾸므로 시험을 먼저 쓰는 단계는 없다. 1, 2로 규칙을 정한 뒤 3~6이 그 규칙을 가리키게 한다.

## 검증

- `npm ci`, `npm run typecheck`, `npm test`, `npm run package:zip`, `unzip -tq dist/coordinator-board-<version>.zip`.
- `unzip -l dist/coordinator-board-<version>.zip`에 `intent/` 항목이 없다(R5).
- 커밋·푸시 때 로컬 공개 위생 검사 통과, PR 본문은 올리기 전에 같은 검사(R6).
- 바뀐 한국어 문서에 em dash가 없다.

## 위험과 확인할 것

- `npm pack`은 `files`와 상관없이 루트의 README와 LICENSE를 담는다. 하위 폴더의 `intent/README.md`가 담기지 않는지 ZIP 목록으로 확인한다.
- `AGENTS.md`의 근거 줄 번호는 이 PR에서 코드가 바뀌지 않으므로 그대로다.
