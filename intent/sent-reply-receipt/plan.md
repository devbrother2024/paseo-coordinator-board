# Plan: 보낸 답장의 접힌 카드

Spec: [spec.md](spec.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #54)

## 단위

여러 질문 카드 첫 질문 표시와 같은 PR, 커밋 하나.

1. 시험 먼저: `test/decision-receipts.test.ts`(판정·기록 찾기·펼친 내용), `test/tracked-decisions.test.ts`(`cardRemoved`).
2. `shared/reply-history.ts`: `cardRemoved` 선택 필드.
3. `server/tracked-decisions.ts`: 답장 기록에 `cardRemoved`.
4. `client/decision-receipts.ts`: `RECEIPT_KEEP_MS`, `receiptEntry`, `settleReceipt`, `receiptDetails`, `receiptsToFold`에서 `sent` 제외.
5. `client/board.tsx`: 결과에 `sentAt`·`match`, 스냅숏마다 `settleReceipt`.
6. `client/inline-receipt.tsx`: 접힌 줄과 펼친 내용.
7. README·OVERVIEW 한 줄.
8. 리뷰 반영: 보낸 시각의 날짜·연도(`sentTimeLabel`), 접힌 카드를 결과 줄 세기와 공통 필터에서 제외(`holdsActivityClosed`, `needsHostWideFilter`, `receiptInScope`).

## 검증

`npm run typecheck`, `npm test`, `npm run package:zip` 뒤 `unzip -tq`, 지어낸 데이터로 웹 미리보기(한·영, 390px·넓은 화면).

## 위험

- 스냅숏 새로 고침이 멈추면 24시간 접기도 늦어진다. 숨기기로 바로 접을 수 있다.
