# Spec: 보낸 답장의 접힌 카드

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #54)

## 1. 범위

화면의 결과 줄(`client/decision-receipts.ts`, `client/inline-receipt.tsx`, `client/board.tsx`)과 답장 기록 항목(`shared/reply-history.ts`의 `replyEntry`)에 선택 필드 하나.

이 폴더를 만든 이유: 서버와 화면 사이의 RPC 계약(`replyEntry`, 스냅숏의 `replyHistory`)에 필드를 더한다.

## 2. 계약

- `replyEntry.cardRemoved?: true`(선택). 원장 답장 기록에서, 원장을 온전히 읽었고(`ok` 또는 `absent`) 그 기록의 카드 키가 원장에 더는 없을 때만 붙는다. 원장을 일부만 읽은 경우(`partial`), 읽지 못한 경우, 세션 질문 답장에는 붙지 않는다. 옛 화면은 이 필드를 무시한다.
- 결과 줄(`CompletedAction`)에 화면 안에서만 쓰는 선택 필드: `sentAt`(보낸 시각, ms), `match`(답장 기록 항목을 찾는 열쇠: 프로젝트, `origin.cardId`, `origin.revision`). 저장하지 않는다.

## 3. 동작

- 남는 결과: 상태가 `sent`인 결과 줄. 다른 결과는 지금처럼 `RECEIPT_FOLD_MS`(6초) 뒤 접힌다. `unsent`는 숨길 때까지 남는다.
- 기록 찾기: `match`의 프로젝트, 카드, 판본이 같고 받은 세션이 같은 답장 기록 가운데 가장 최근 것.
- 접기 판정(`settleReceipt`), 스냅숏이 새로 올 때마다:
  - 보낸 지 24시간(`RECEIPT_KEEP_MS`)이 지났으면 접는다.
  - 찾은 기록에 후속 응답이 있거나 `cardRemoved`면, 처음 본 새로 고침에는 표시만 해 두고(`settled`) 그다음 새로 고침에 접는다. 후속 응답 첫 줄을 한 번은 볼 수 있게 하기 위해서다.
  - 기록을 아직 찾지 못했으면 그대로 둔다.
- 펼친 내용(`receiptDetails`): 보낸 글 전체, 사진 N장(기록의 `imageCount`), 받은 세션 이름, 후속 응답 첫 줄. 없는 줄은 빼고 보여 준다.

## 4. 시험 기준

- `settleReceipt`: 24시간 전후, 응답 첫 확인 → 표시만, 다음 새로 고침 → 접힘, `cardRemoved` 같은 흐름, 기록 없음 → 그대로, `sent` 아닌 결과와 숨긴 결과는 그대로.
- `receiptsToFold`: `sent`는 6초 접기에서 빠진다.
- `receiptEntry`: 카드·판본·받는 세션이 맞는 가장 최근 기록.
- `receiptDetails`: 줄 구성과 두 언어.
- 서버: 원장에 카드가 있으면 `cardRemoved` 없음, 원장에서 내려가면 있음, 일부만 읽으면 없음.

## 5. 버린 설계

- 보드 데이터 파일에 결과 줄 저장: 재시작 뒤에도 남지만 최근 결정 기록과 같은 내용을 두 곳에 두게 된다.

## 6. 열린 질문

없음.
