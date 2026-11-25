# Spec: 카드 입력 하나, 병합 카드 수정 요청, 세션 글의 질문 블록

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 1. 범위

- 화면: 원장 카드(`client/tracked-decisions.tsx`), 세션 대화 카드(`client/decision-actions.tsx`), 병합 카드(`client/pull-requests.tsx`), 접힌 카드(`client/decision-receipts.ts`, `client/inline-receipt.tsx`), 조립(`client/board.tsx`).
- 판정: `client/card-input.ts`, `shared/question-block.ts`, `shared/pull-change-requests.ts`, `shared/pull-judgments.ts`, `shared/merge-card-place.ts`.
- 서버: 카드 정보 머리(`server/decision-message.ts`), 원장 답장 기록(`server/tracked-decisions.ts`), 수정 요청 전송(`server/pull-change-requests.ts`), 대화 읽기(`server/conversation.ts`, `server/session-decisions.ts`), 호스트 설정(`server/preferences.ts`).

이 폴더를 만든 이유: 세션에 보내는 전송이 하나 늘고(수정 요청), 서버와 화면 사이 RPC 계약과 플러그인 데이터 파일(호스트 설정, 원장 답장 기록)에 필드가 더해지며, 세션이 쓰는 공개 형식(질문 블록)이 생긴다. 버린 대안도 남길 가치가 있다.

## 2. 동작 계약

### 2.1 카드 입력 하나

- 원장 카드와 세션 대화 카드는 입력창 하나와 **보내기** 하나를 낸다. 카드의 **질문하기**(따로 열리는 질문 입력)는 내지 않는다. 지난 문답은 **근거·이력 보기**에 그대로 보인다.
- 버튼 이름(`sendWords`): 결정 카드는 "보내기 / Send", 병합 카드는 "수정 요청 보내기 / Send change request". 받는 곳은 버튼 옆 한 줄과 접근성 이름에 적는다.
- 원장 카드의 입력창(`trackedDraftLayout`):
  - 질문이 없는 카드: 지금의 자유 입력창이 그 입력창이다.
  - 질문이 하나인 카드: 그 질문의 입력창이 그 입력창이다(선택지를 고르거나 글을 쓴다).
  - 질문이 여럿인 카드: 질문 아래에 카드 입력창이 늘 보인다. **보내기**도 늘 보인다.
  - 세션 질문과 묶인 카드(질문 없음)는 묶인 세션 카드의 입력창을 쓴다. 병합 카드가 수정 요청 입력을 내는 동안에는 원장 쪽 자유 입력창을 내지 않는다. 다만 원장 쪽에 이미 쓴 글이나 사진이 있으면 그 입력창을 그대로 둔다(새로 고침으로 병합 입력이 생겨도 쓰던 것이 사라지지 않게).
- 보낼 수 있는 때(`openQuestionsBlock`): 답하지 않은 질문이 남아 있어도, 카드 입력창에 글이나 사진이 있으면 보낼 수 있다. 글도 사진도 없으면 지금처럼 모든 질문에 답하거나 건너뛰어야 한다.
- 선택지 설명이 빠진 카드의 요청 문장 넣기 버튼은 카드 입력창을 채운다(`withRequest`: 이미 쓴 글은 두고 한 번만 덧붙인다). 보내는 것은 사람이다.
- 보드는 글을 분류하지 않는다. 전송 경로, 받는 곳 판정, 대기열은 지금과 같다(`board.resolve-tracked-decision`, `board.send-decision`의 `reply`).

### 2.2 받는 쪽에 알리는 값

카드 글 앞에 붙는 카드 정보(JSON 한 줄)에 값을 더한다.

```json
{"action":"reply","mayBe":["decision","question","change-request"]}
```

- `mayBe`는 "이 글은 이 가운데 하나일 수 있다"는 뜻이다. 문장이 아니고, 사람이 쓴 글은 지금처럼 빈 줄 뒤에 그대로 붙는다.
- 붙는 곳: 원장 카드 답(`trackedReplyMessage`), 세션 대화 카드 답(`sessionReplyMessage`의 `reply`), 병합 카드 수정 요청. 코디네이터 조율 요청과 승인 요청 카드의 질문은 지금 그대로다.
- 호환: 원장 답장 기록에 선택 필드 `headerVersion?: 2`. 이 필드가 없는 기록(이 변경 전에 쓰였거나 대기열에 있던 답)을 다시 보내거나 확인할 때는 옛 모양(값 없음)으로 글을 만든다. 기록된 메시지 해시가 그대로 맞는다.
- 받는 쪽이 할 일(README와 코디네이터 헌장에 적는다): 결정이면 처리하고 카드를 내린다. 질문이나 수정 요청이면 답하거나 반영하고, 사람이 정할 일이 남았으면 카드를 새 내용으로 다시 올린다.

### 2.3 닫힘과 다시 열림

- 원장 답장 기록은 지금처럼 개정(카드 열쇠와 내용 지문)마다 하나다. 보낸 개정은 "내 결정"에서 빠지고, 카드가 새 내용으로 올라오면(지문이 달라지면) 다시 열린다. 저장 형식은 바뀌지 않는다.
- 기록의 뜻은 "이 개정에 보냈다"이다. 화면 문구에서 "기록을 닫았습니다"를 쓰지 않는다.
- 접힌 "보냄" 카드(`settleReceipt`):
  - 보낸 지 24시간이 지나면 접는다(그대로).
  - 원장에서 카드가 내려갔으면(`cardRemoved`) 한 번 보인 뒤 다음 새로 고침에 접는다(그대로).
  - 원장 카드 답: 받는 쪽 응답이 와도 카드가 원장에 남아 있는 동안에는 접지 않는다. 응답 첫 줄이 계속 보인다. **바뀜**: 지금은 응답이 오면 다음 새로 고침에 접는다.
  - 세션 대화 카드 답과 수정 요청: 응답이 오면 한 번 보인 뒤 접는다(그대로).
- 지금 흐름과 차이: 저장과 "내 결정" 목록은 같다. 달라지는 것은 (1) 질문만 써서 보내도 그 개정이 목록에서 빠진다는 점(전에는 질문하기로 보내면 카드가 남았다), (2) 접힌 카드가 원장에서 카드가 내려갈 때까지 남는다는 점, (3) 받는 쪽이 다시 물을 때 카드를 새 내용으로 올려야 한다는 약속이다.

### 2.4 병합 카드 수정 요청

RPC `board.request-pull-changes`:

- 입력: `projectId`, `repo`, `number`, `headSha`(40자 hex), `recipientId`, `text`(4,000자 이내), `images`(선택), `requestKey`. 글이나 사진 가운데 하나는 있어야 한다.
- 출력: `status`가 `sent`, `changed`, `busy`, `unconfirmed` 가운데 하나. `sent`에는 `recipientId`.
- 받는 곳(`changeRequestRecipient`): 병합 판단 기록의 `ownerSessionId`가 이 호스트의 관리 세션이고, 그 PR의 프로젝트에 있고, 종료·오류가 아니며 권한 요청을 기다리지 않으면 그 세션. 아니면(없음, 보관됨, 다른 기기, 종료, 오류, 권한 대기) 코디네이터. 코디네이터도 없으면 보낼 수 없다.
- 서버 검사(순서대로): 프로젝트가 관리 대상인가. PR이 지금 병합 카드인가(GitHub 준비됨, 병합 카드 줄). 머리 커밋이 입력과 같은가. 받는 곳이 판정과 같은가. 받는 세션이 살아 있는가(`archivedAt`, `internal` 아님). 통과하지 못하면 `changed`이고 아무것도 보내지 않는다.
- 일하는 중인 받는 세션: 카드 답장과 같은 판정(`canReceiveBoardInput`에 진행 중 턴 허용)을 쓴다. Claude와 Codex는 진행 중인 턴에 바로 받는다. 그 밖의 실행기가 턴 중이면 요청을 기록에 `queued`로 두고(`queue`: 멈춤, 병렬 보류, 사진 참조) 사진은 호스트에 보관하며 `queued`를 돌려준다. 권한 요청을 기다리거나 오류 상태면 `busy`이고 아무것도 남기지 않는다.
- 기다리는 요청: 받는 세션의 턴 종료·권한 처리 훅과 다음 스냅숏에서 다시 본다. PR이 같은 머리로 열려 있고 GitHub 준비 상태이며 받는 곳이 그대로일 때만 보낸다. 어긋나면 멈춤으로 바꾸고 보내지 않는다. 보낼 때의 글은 수정 요청 머리와 사람 글 그대로다(카드 답장의 진행 중 전송은 세션이 스스로 물은 질문이라 글만 보내지만, 수정 요청은 어느 PR에 대한 것인지가 필요하다).
- 기다리는 요청의 관리(`board.manage-queued-answer`, 카드 종류 `pull`): 취소는 기록을 지워 병합 카드가 돌아오게 한다. 병렬 세션 요청과 재개는 카드 답장과 같은 조건(`canChangeQueue`)과 같은 전송(출처를 붙인 코디네이터 요청)을 쓴다. 받는 곳이 코디네이터 자신이면 병렬 요청을 내지 않는다. 병렬 요청에 실리는 카드 이름은 `repo #number`이고 PR 제목은 넣지 않는다. 기다리는 중에 PR 머리가 바뀌면 그 요청은 보내지 않는다: PR 줄에 멈춘 상태로 남아(`changeQueueHead`가 쓴 머리를 알린다) 읽고 취소할 수 있고, 새 머리에 대한 수정 요청을 보내면 그 자리를 대신한다. 기다리는 동안에도 병합 카드는 내려가 있고 보드의 병합은 거절된다.
- 전송: 카드 정보 머리와 사람이 쓴 글. 출처 없이 보낸다(사람이 쓰고 누른 글). 머리의 `action`은 `change-request`, `mayBe`는 2.2와 같고, PR은 `repo`, `number`, `url`, `headSha`로만 가리킨다. PR 제목은 넣지 않는다: GitHub에서 PR을 고칠 수 있는 사람이 정하는 글이라, 출처 없는 메시지에 실리면 받는 세션이 사람의 말로 읽을 수 있다. 머리말은 프로젝트 이름과 `repo #number`다.
- 저장(호스트 설정 `pullChangeRequests`, 선택 필드, PR마다 최신 하나, 최대 200개): `repo`, `number`, `projectId`, `headSha`, `title`, `text`, `recipientId`, `coordinator`, `messageId`, `messageHash`, `fingerprint`, `at`, `status`(`queued` → `pending` → `sent`), `queue?`, `requestKey?`, `imageCount?`, `withdrawnAt?`.
- 재시도: 같은 `requestKey`로 다시 부르면 다시 보내지 않는다. 기록이 `sent`면 `sent`, `pending`이면 받는 세션 대화에서 그 메시지를 찾아 있으면 `sent`, 없으면 `unconfirmed`. 다른 요청의 `pending`은 10분 동안 새 전송을 막는다(`unconfirmed`). 거둔 기록(`withdrawnAt`)은 끝난 요청이다. 그 뒤의 요청은 열쇠와 글이 같아도 새 메시지로 보낸다. 기록에 그 요청의 열쇠(`requestKey`)를 남겨, 다시 연 뒤에 보낸 요청을 다시 불러도 같은 요청으로 확인한다. 화면은 전송에 성공하면 열쇠를 버린다.
- `pending` 확인: 보드가 받는 세션 대화에서 같은 메시지(ID와 해시)를 읽으면 `sent`로 바꾼다(`changeRequestHistory`).
- 병합 카드가 내려가는 조건(`applyPullJudgments`, `holdsMergeCard`): 거두지 않은 요청(`sent` 또는 `pending`)의 `headSha`가 PR의 지금 머리와 같으면 줄이 `progress`, 문이 `change-requested`. 그 머리에 대한 병합 판단은 언제 쓰였든 이것을 풀지 않는다(코디네이터는 정기 점검에서 같은 머리를 다시 판단할 수 있고 수정 요청을 모를 수 있다). PR 항목의 `changeRequest`가 `sent`인지 `pending`인지 알린다. 병합 판단 설정이 꺼져 있어도 같다.
- 보드의 병합 거절: 같은 조건이면 병합 미리보기(`board.preview-pull-request-merge`)는 표를 내주지 않고, 병합 확정(`board.confirm-pull-request-merge`)은 미리보기를 연 뒤에 요청이 들어온 경우에도 병합하지 않는다. 둘 다 `blocked`와 이유 `change-requested`를 돌려주고, 화면은 "수정 요청을 보낸 PR입니다. 병합하려면 병합 카드 다시 열기"를 두 언어로 보인다. 다른 화면에 남아 있던 옛 병합 카드에서 눌러도 같다. GitHub에서 직접 하는 병합은 막지 않는다.
- 원장 병합 카드(`waitingMergeCard`): 그 PR의 문이 `change-requested`면 프로젝트 진행의 PR 줄로 기다린다.
- 다시 뜨는 조건은 둘뿐이다: 새 머리 커밋(있던 판단이 풀리고 다시 판단을 거친다), 사람이 누른 **병합 카드 다시 열기**(`board.withdraw-pull-change-request`, 아무것도 보내지 않고 기록에 `withdrawnAt`만 남긴다. `pending`인 요청도 거둘 수 있다).
- 쓰는 중에 바뀐 대상(`changeDraftTarget`): 초안은 쓸 때 화면에 있던 커밋과 받는 곳에 묶인다. 새로 고침으로 둘 중 하나가 바뀌면 글은 그대로 두고, 사람이 바뀐 내용을 확인하기 전에는 보내기를 끈다(원장 카드 답과 같은 방식).
- 보낸 뒤 화면: 그 자리에 접힌 "수정 요청 보냄" 카드(보낸 글, 받은 세션, 응답 첫 줄). 최근 결정 기록에도 남는다.

### 2.5 세션 글의 질문 블록

세션이 글의 맨 끝에 쓰는 펜스 코드 블록이다. 언어 이름은 `board-question`, 안은 JSON이다.

````markdown
```board-question
{
  "questions": [
    {
      "id": "Q1",
      "text": "캐시를 어디에 둘까요?",
      "options": [
        { "key": "A", "text": "메모리", "does": "프로세스 안에 둡니다", "pros": "빠릅니다", "cons": "재시작하면 비워집니다", "recommended": true },
        { "key": "B", "text": "디스크", "does": "파일로 남깁니다" }
      ]
    }
  ],
  "recommend": "A. 지금 규모에서는 메모리로 충분합니다.",
  "recommendedReply": "Q1은 A로 진행해 주세요."
}
```
````

- 필드: `questions`(1개에서 8개). 질문마다 `text`(필수, 500자), `id`(선택, 24자), `multi`(선택, 여러 개 선택), `options`(0개에서 8개). 선택지마다 `key`(필수, 16자), `text`(필수, 300자), `does`·`pros`·`cons`(선택, 400자), `recommended`(선택). 블록에 `recommend`(선택, 600자), `recommendedReply`(선택, 2,000자). 모르는 필드는 무시한다.
- 크기: 블록 안 글은 12,000자까지. 글자 수는 제어 문자와 양방향 제어 문자를 지우고 공백을 정리한 뒤에 센다(`recommendedReply`는 줄 바꿈을 남긴다).
- 틀린 블록: JSON이 아니거나, 상한을 넘거나, 필수 값이 비었거나, 한 질문 안에서 `key`가 겹치거나, 질문 이름표(`id · text`)가 겹치면 블록 전체를 쓰지 않는다. 글은 지금처럼 그대로 보인다.
- 자리: 글의 마지막이어야 한다. 블록 뒤에 다른 글이 있으면 블록으로 읽지 않는다. 글의 코드 펜스를 처음부터 따라가며, 다른 펜스 밖에 있고 닫힌 마지막 블록 하나만 본다. 본문 중간에 인용한 옛 블록은 예시로 남고 끝의 블록이 질문이 된다. 다른 펜스 안에 든 블록(바깥 펜스가 닫히지 않은 경우 포함), 닫히지 않은 블록, 들여쓴 블록은 읽지 않는다.
- 맞는 블록이면: 그 글은 블록을 뺀 나머지로 읽고, 블록 앞 글에 질문 문장이 없어도 결정 카드가 된다(제목은 첫 질문). 글에서 이름표를 찾는 안내는 내지 않는다.
- RPC 계약: 세션의 `decision`에 선택 필드 `block`(위 모양을 정리한 값). 카드 판본(`version`)에는 넣지 않는다(판본은 대화 근거에 묶여 있다).
- 화면: 질문마다 선택지를 원장 카드처럼 그린다. 고르면 입력창에 `Q1 · 캐시를 어디에 둘까요?: A · 메모리` 같은 줄이 채워진다(`applyBlockChoice`). 고른 표시는 입력창의 글에서 읽는다(`blockPicks`). 그래서 사람이 그 줄을 고치거나 지우면 표시도 따라 바뀐다. 사람이 그 줄 뒤에 덧붙인 글(조건, 직접 쓴 답)은 다른 선택지를 고르거나 고른 것을 풀어도 남는다. **추천 답 넣기**는 `recommendedReply`를 입력창에 넣는다. **추천대로 모두 고르기**는 원장 카드와 질문 블록 카드 모두에서 없앤다(유지관리자 요청): 선택지 옆 **추천** 표시와 카드의 추천 줄은 그대로 두고, 질문마다 사람이 직접 고른다. 질문이 하나인 원장 카드의 **추천 선택지 고르기**도 같은 이유로 없앤다(추천 선택지를 직접 누르는 것과 같은 한 번 누르기). 선택지가 없는 카드의 **추천 답 넣기**는 고를 선택지가 없으므로 그대로 둔다. `does`·`pros`·`cons`는 **근거·이력 보기**를 펼치면 보인다.

## 3. 경계와 실패 처리

- 수정 요청의 전송 결과를 모르면(`pending`) 도착했을 수도 있으므로 병합 카드를 내리고 보드에서 병합하지 않는다. PR 줄에 "수정 요청 전송 확인 중"이 보이고, 받는 세션 대화에서 확인되면 `sent`가 된다. 다시 보내려면 **병합 카드 다시 열기**를 누른다.
- 호스트 설정의 `pullChangeRequests`에서 읽지 못하는 기록은 그 기록만 버린다. 다른 설정과 다른 기록은 그대로 읽힌다.
- 수정 요청의 머리말과 카드 정보에 들어가는 프로젝트 이름은 제어 문자와 양방향 제어 문자를 지운다. 사람이 쓴 글은 고치지 않는다.
- 받는 세션이 권한 요청을 기다리거나 오류 상태면 `busy`를 돌려주고 아무것도 남기지 않는다. 일하는 중이면 위 규칙대로 바로 보내거나 기다린다.
- 호스트 설정의 `pullChangeRequests`가 없거나 비어 있으면 지금과 같이 동작한다. 원장 답장 기록의 `headerVersion`이 없으면 옛 모양으로 읽는다.
- 질문 블록을 읽다가 나는 오류는 모두 "블록 없음"으로 처리한다. 보드는 멈추지 않는다.
- 코디네이터가 없고 작업 세션도 받을 수 없으면 병합 카드의 입력은 꺼지고 이유를 보인다.

## 4. 요구사항과 시험

| 요구 | 내용 | 시험 |
|---|---|---|
| R1 | 버튼 이름은 결정 카드 "보내기", 병합 카드 "수정 요청 보내기"이고 받는 곳을 함께 적는다 | `test/card-input.test.ts` "a decision card sends with Send, a merge card with Send change request" |
| R2 | 입력창 자리는 질문 수와 묶인 세션, 병합 카드 입력에 따라 정해진다 | `test/tracked-reply-draft.test.ts` "a card has one input: its own, its single question's, or the merge card's" |
| R3 | 글이나 사진이 있으면 답하지 않은 질문이 있어도 보낼 수 있다 | `test/card-input.test.ts` "open questions block sending only while the card's input is empty" |
| R4 | 요청 문장은 이미 쓴 글을 두고 한 번만 덧붙는다 | 같은 파일 "a suggested request joins what the person wrote, once" |
| R5 | 카드 답의 머리에 `mayBe`가 들어가고 사람 글은 그대로다 | `test/decision-message.test.ts` "a card reply says it may be a decision, a question or a change request" |
| R6 | `headerVersion`이 없는 기록은 옛 모양으로 다시 확인되고, 새 기록은 `headerVersion: 2`다 | `test/tracked-decisions.test.ts` "a reply queued before the header change is still delivered as it was written" |
| R7 | 질문에 답하지 않고 글만 보낸 개정은 목록에서 빠지고, 새 내용으로 올라오면 다시 열린다 | 같은 파일 "a free-text reply to a card with questions hides that revision until the card changes" |
| R8 | 원장 카드 답의 접힌 카드는 응답이 와도 원장에서 내려갈 때까지 남는다 | `test/decision-receipts.test.ts` "a ledger reply stays through its follow-up until the card is taken down" |
| R9 | 받는 곳은 살아 있고 권한 대기가 아닌 담당 세션, 아니면 코디네이터다 | `test/pull-change-requests.test.ts` "the request goes to the owner session, or to the coordinator when the owner cannot take it" |
| R10 | 지금 머리에 보낸 요청이 있으면 병합 카드가 내려간다. 새 머리와 거두기로만 다시 뜨고, 같은 머리의 새 판단으로는 뜨지 않는다 | `test/pull-judgments.test.ts` "a change request on the current head takes the merge card down until a new head or a withdrawal" |
| R11 | 원장 병합 카드도 그 PR 줄과 함께 기다리고 결정 수에서 빠진다 | `test/merge-card-place.test.ts` "a ledger merge card waits with its PR after a change request" |
| R12 | 서버는 병합 카드가 아니거나 머리·받는 곳이 다르면 보내지 않고, 권한 대기·일하는 중이면 `busy`다 | `test/pull-change-requests.test.ts` "nothing is sent unless the PR is a merge card on that head and the recipient can take input" |
| R13 | 같은 요청을 다시 부르면 다시 보내지 않고, 전송에는 출처를 붙이지 않는다 | 같은 파일 "a retry confirms the earlier request instead of sending again" |
| R14 | 거두기는 아무것도 보내지 않고 기록만 남긴다 | 같은 파일 "withdrawing reopens the merge card without sending" |
| R15 | 맞는 블록은 정리된 값으로 읽히고 글에서 빠진다 | `test/question-block.test.ts` "a block at the end of a message is read and taken out of the text" |
| R16 | 틀린 블록, 상한을 넘는 블록, 끝이 아닌 블록은 쓰지 않는다 | 같은 파일 "a malformed, oversized or misplaced block is ignored" |
| R17 | 제어 문자와 양방향 제어 문자는 지워진다 | 같은 파일 "control characters are removed before the block is shown" |
| R18 | 선택지를 고르면 입력창의 그 질문 줄이 채워지고, 고른 표시는 글에서 읽는다 | 같은 파일 "choosing an option writes that question's line, and the text says what is chosen" |
| R19 | **추천대로 모두 고르기**(여러 질문 카드, 질문 블록 카드)와 **추천 선택지 고르기**(질문 하나 카드) 버튼과 그 판정은 없다. 추천 표시, 추천 줄, **추천 답 넣기**는 남는다 | 화면 확인(R21), 판정 함수 제거 |
| R20 | 블록이 있는 글은 질문 문장이 없어도 결정 카드가 되고 `decision.block`이 실린다 | `test/conversation.test.ts` "a message ending in a question block becomes a decision card with its options" |
| R22 | 거둔 뒤의 요청은 열쇠와 글이 같아도 새 메시지로 나가고, `pending`인 요청도 거둘 수 있다 | `test/pull-change-requests.test.ts` "a request sent again after the card was reopened is a new request, even with the same key and words" |
| R23 | 지금 머리에 요청(`sent`, `pending`)이 있으면 보드의 병합 미리보기와 확정이 거절되고, 거두기와 다른 머리에서만 풀린다(같은 머리의 새 판단으로는 풀리지 않는다) | `test/pr-merge.test.ts` "a PR with a change request on its head is not merged from the board until the card is reopened" |
| R24 | `pending`인 요청은 받는 세션 대화에서 읽히면 `sent`가 된다 | `test/pull-change-requests.test.ts` "a pending request is confirmed when the board reads it in the recipient's conversation" |
| R25 | 수정 요청은 PR 제목 없이 저장소·번호·링크·커밋으로만 PR을 가리키고, 머리말에서 제어·양방향 문자를 지우며 사람 글은 그대로 둔다 | 같은 파일 "a change request names its PR without the PR title, and carries no control or direction characters" |
| R26 | 읽지 못하는 수정 요청 기록 하나는 그 기록만 버려진다 | 같은 파일 "one unreadable change request record is dropped without losing the rest of the settings" |
| R27 | 끝의 블록은 앞에 인용한 블록과 따로 읽히고, 다른 펜스 안의 블록은 읽지 않는다 | `test/question-block.test.ts` "only a block that stands on its own at the very end counts, whatever the message quotes before it" |
| R28 | 같은 글·사진·대상으로 다시 누르면 같은 열쇠로 확인만 하고, 글·사진·커밋·받는 곳이 바뀌면 새 요청이다 | `test/change-request-draft.test.ts` "an unchanged retry keeps its key, and an edited draft or another target gets a new one" |
| R29 | 쓰는 중에 PR의 커밋이나 받는 곳이 바뀌면 확인하기 전에는 보내지 않는다 | 같은 파일 "a draft written for one commit and recipient waits for a look when either changes" |
| R30 | Claude·Codex는 진행 중인 턴에 바로 받고, 그 밖의 실행기는 기다렸다가 쉬면 한 번만 받는다. 기다리는 동안 병합 카드는 내려가 있다 | `test/pull-change-requests.test.ts` "a session in its turn takes the request at once when its provider can, and otherwise the request waits" |
| R31 | 기다리는 요청은 PR의 머리·준비 상태·받는 곳이 달라지면 멈추고 보내지 않는다. 권한 대기로 바뀌면 계속 기다린다 | 같은 파일 "a waiting request stops when the PR or its recipient is no longer what the person wrote for" |
| R32 | 기다리는 요청은 취소(병합 카드 복귀), 병렬 세션 보류, 재개를 할 수 있다 | 같은 파일 "a waiting request can be cancelled, held for a parallel session and resumed" |
| R33 | 기다리는 중에 PR 머리가 바뀐 요청은 멈춘 상태로 PR 줄에 남아 취소할 수 있고, 새 머리에 대한 요청이 그 자리를 대신한다 | `test/pull-change-requests.test.ts` "a request left waiting when the PR moved on can still be seen, cancelled or replaced" |
| R34 | 수정 요청마다 접힌 카드가 따로 남는다. 병합 카드를 다시 연 뒤 같은 머리로 또 보내도 두 번째 카드가 버려지지 않는다 | `test/change-request-draft.test.ts` "each change request leaves its own folded card, also when sent again about the same head" |
| R35 | 기다리는 요청의 조작과 병합 카드 다시 열기는 기록된 프로젝트로 보낸다(두 관리 프로젝트가 같은 저장소를 여는 경우) | 같은 파일 "the controls of a waiting request name the project and head it was recorded under", `test/pull-judgments.test.ts`의 `changeProjectId` |
| R21 | 화면: 카드 입력 하나, 보낸 뒤 접힘과 다시 열림, 병합 카드 수정 요청, 질문 블록 카드 | 지어낸 데이터의 웹 미리보기(한·영, 넓은 화면·390px), 캡처는 `docs/pr-assets/single-card-input/` |

## 5. 버린 설계

- `action`을 `reply`에서 다른 값으로 바꾸기: 옛 기록의 해시가 맞지 않고, 값을 읽던 쪽이 있으면 깨진다. 값을 더하는 쪽을 골랐다.
- 수정 요청을 병합 대기(`MergeHold`)로 다루기: 대기는 화면이 다른 기기까지 읽어 계산한다. 수정 요청은 서버가 아는 사실이므로 병합 판단과 같은 자리(문)에서 정한다. 결정 수와 화면이 같은 값을 본다.
- 요청이 `pending`일 때 병합 카드를 그대로 두기: 다시 누를 자리는 남지만, 도착했을 수도 있는 수정 요청을 두고 병합할 수 있다. 내리고, 되돌리는 길을 **병합 카드 다시 열기**로 둔다.
- 요청 뒤 같은 머리에 쓰인 새 판단으로 병합 카드를 다시 띄우기: 코디네이터는 정기 점검에서 같은 머리를 다시 준비됐다고 기록할 수 있고, 사람이 수정을 요청한 것을 모를 수 있다. 사람이 요청한 것은 사람이 거두거나 새 커밋이 올라올 때만 풀린다.
- 수정 요청을 화면에서만 가리기: 다른 기기나 새로 고치지 않은 화면의 옛 카드에서 병합된다. 서버의 병합 경로가 같은 기록을 본다.
- 수정 요청 머리에 PR 제목 넣기: 받는 세션이 무엇에 대한 글인지 읽기는 쉽지만, 남이 고칠 수 있는 글이 사람의 말과 같은 권위로 전달된다. 번호와 링크로 충분하다.
- 블록을 정규식 하나로 찾기: 앞에 인용한 블록과 끝의 블록이 하나로 묶이거나, 닫히지 않은 바깥 펜스 안의 블록이 질문으로 읽힌다.
- 블록의 고른 표시를 따로 저장하기: 입력창의 글과 표시가 어긋날 수 있다. 글 하나만 진실로 둔다.
- 블록을 글 어디에 있든 읽기: 예시로 쓴 블록이 카드가 된다.

## 6. 열린 질문 (제안 답)

- 질문이 여럿인 원장 카드의 **다르게(직접 적기)**도 카드 입력창으로 합칠까: 이번에는 두었다. 질문별 사진과 답 요약이 그 입력에 묶여 있다. 합치려면 단계 화면을 다시 짜야 하므로 따로 정한다.
- 이미 떠 있는 코디네이터에 새 안내를 어떻게 전할까: 헌장은 세션을 만들 때만 들어가므로, 떠 있는 코디네이터는 `mayBe`와 질문 블록 안내를 받지 못한다(알려진 한계). 코디네이터가 읽는 안내 도구가 생기면 그 안내에 질문 블록 형식과 `mayBe` 처리를 넣는다.
