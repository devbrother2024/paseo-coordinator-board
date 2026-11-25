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
    - 원장 카드 답은 [single-card-input](../single-card-input/spec.md)에서 바뀌었다: 후속 응답만으로는 접지 않고, 원장에서 카드가 내려갈 때까지 남는다.
  - 기록을 아직 찾지 못했으면 그대로 둔다.
- 펼친 내용(`receiptDetails`): 보낸 글 전체, 사진 N장(기록의 `imageCount`), 받은 세션 이름, 후속 응답 첫 줄. 없는 줄은 빼고 보여 준다.
- 보낸 시각(`sentTimeLabel`): 오늘이면 시각만, 오늘이 아니면 날짜도, 올해가 아니면 연도도 붙인다. 보드 언어를 따른다.
- 접힌 카드는 결과 줄이 아니다: 결정이 0건일 때 최근 결정 기록이 저절로 펼쳐지는 것을 막지 않고(`holdsActivityClosed`), 프로젝트 없는 접힌 카드만 남았을 때 0건 "공통" 필터를 띄우지 않는다(`needsHostWideFilter`). 프로젝트 없는 접힌 카드는 필터를 고르지 않은 동안 보인다(`receiptInScope`).

## 4. 요구사항과 시험

| 요구 | 내용 | 시험 |
|---|---|---|
| R1 | 답장 보냄 결과는 6초 접기에서 빠지고, 다른 결과는 그대로 접힌다 | `test/decision-receipts.test.ts` "a finished result folds into recent activity after a few seconds, except a sent or unsent reply" |
| R2 | 접힌 카드는 같은 카드·판본·받는 세션의 가장 최근 답장 기록을 찾는다 | 같은 파일 "finds the latest history entry for the same card, revision and recipient" |
| R3 | 보낸 지 24시간이 지나면 접힌다 | "stays until a day has passed" |
| R4 | 후속 응답은 한 번 보인 뒤 다음 새로 고침에 접힌다 | "a follow-up shows once, then the next refresh folds it" |
| R5 | 원장에서 내려간 카드는 다음 새로 고침에 접힌다 | "a card taken down from the ledger folds on the next refresh" |
| R6 | 다른 결과와 숨긴 결과는 접기 판정이 건드리지 않는다 | "other results and hidden ones are left alone" |
| R7 | 펼친 내용은 보낸 글, 사진 장수, 받은 세션, 후속 응답 첫 줄이고 두 언어로 나온다 | "the opened card lists what was sent, photos, the recipient and the follow-up's first line" |
| R8 | 서버는 원장을 온전히 읽었을 때만, 카드 키가 원장에 없으면 `cardRemoved`를 붙인다 | `test/tracked-decisions.test.ts` "a reply's history says when its card was taken down from a fully read ledger" |
| R9 | 보낸 시각은 오늘이 아니면 날짜를, 올해가 아니면 연도를 함께 보인다 | `test/decision-receipts.test.ts` "the folded card shows the time, and the date too when it was not sent today" |
| R10 | 접힌 카드는 최근 결정 기록의 자동 펼침을 막지 않는다 | "it does not keep Recent decision activity closed when no decision is left" |
| R11 | 프로젝트 없는 접힌 카드만으로는 공통 필터를 띄우지 않고, 필터가 없을 때는 보인다 | "a host-wide sent reply alone adds no Host-wide filter, yet still shows while no filter is set" |
| R12 | 접힌 줄, 펼치기, 결정 수 미포함이 화면에서 동작한다 | 지어낸 데이터의 웹 미리보기(한·영, 390px) |

## 5. 버린 설계

- 보드 데이터 파일에 결과 줄 저장: 재시작 뒤에도 남지만 최근 결정 기록과 같은 내용을 두 곳에 두게 된다.

## 6. 열린 질문

없음.
