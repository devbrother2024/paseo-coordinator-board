# Plan: resetPasses 읽기, 덧붙이기, 표시

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #59)

## 단위

세션 경로로 한 브랜치와 한 PR에 설계 문서, 코드, 시험, 사용자 문서를 담는다. 설계 문서는 구현 뒤 리뷰 지적으로 더했다.

## 순서

1. 시험을 먼저 쓴다: 파싱, 덧붙이기, 짝짓기, 표시 문구(`test/reset-passes.test.ts`).
2. 공유 스키마에 선택 칸 `resetPasses`, `resetPassesFetchedAt`을 더한다(`shared/usage-routing.ts`).
3. 서버가 파일을 항목별로 검사하고 Paseo 측정 계정에 덧붙인다(`server/display-usage.ts`). 설정 응답에만 병합본을 싣는다(`server/operations.ts`).
4. 표시 문구와 신선도 판정을 `client/reset-passes.ts`에 두고, 카운트다운에 만료 문구 인자를 더한다(`client/reset-countdown.ts`). 화면은 `client/usage-routing.tsx`.
5. README(한국어)와 OVERVIEW(영어)에 형식 예시와 규칙을 같은 내용으로 적는다.

## 검증

- `bun test test/reset-passes.test.ts test/usage-routing.test.ts test/reset-countdown.test.ts`로 R1~R6 확인.
- `npm ci`, `npm run typecheck`, `npm test`, `npm run package:zip`, 배포 ZIP 무결성 검사.
- R7: 지어낸 데이터로 넓은 화면·390px, 한·영 화면 확인.
- 초안 PR의 공개 위생 검사와 운영체제별 CI.

## 위험과 확인할 것

- 설정을 열 때마다 파일을 읽는다. 크기 상한과 심볼릭 링크 거부는 그대로다.
- 운영 도구가 `label`을 Paseo 계정 이름과 다르게 쓰면, 계정이 여럿인 실행기에는 초기화권이 붙지 않는다. README에 규칙을 적었다.
