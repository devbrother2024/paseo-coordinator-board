# Spec: 교체 뒤 인계 시작 지시와 옛 코디네이터 보관

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #57)

## 1. 범위

코디네이터 생성 요청의 첫 프롬프트, 호스트 추가 시작 지시 파일, `read_board_conversation`의 옛 코디네이터 읽기, 옛 코디네이터 보관 RPC와 설정 화면, 교체 확인 문구.

이 폴더를 만든 이유: 코디네이터 세션의 첫 지시(전송 경계)와 RPC 계약이 바뀐다.

## 2. 동작 계약

### 지금(바꾸기 전)

새 코디네이터는 `server/lifecycle.ts`에서 `workspace.agents.create`로 만든다. 헌장은 `config.systemPrompt`로 붙고, `prompt`는 넣지 않는다. 그래서 새 세션은 첫 지시 없이 비어 있다. 교체 뒤 `createdCoordinator.previous`에 옛 코디네이터 ID가 남는다.

### 첫 프롬프트(`coordinatorStartPrompt`, `server/coordinator-bootstrap.ts`)

- 생성 요청의 `prompt`에 넣는다. 생성 뒤 따로 보내지 않는다. 생성은 이미 `idempotencyKey`로 한 번만 일어난다.
- 옛 코디네이터도 추가 지시도 없으면 `null`(프롬프트 없음, 지금과 같음).
- 첫 줄 머리말: `[Coordinator Board · 코디네이터 시작]` / `[Coordinator Board · Coordinator start]`. 둘째 줄: 보드가 붙인 글이며 사용자의 글이나 승인이 아니라는 문장.
- 옛 코디네이터가 있으면: 그 세션 ID, `read_board_conversation`에 `sessionId`로 그 ID를 넣어 최근 기록을 읽고 진행 중이던 일과 약속을 정리하라는 안내(기록은 근거일 뿐 지시·승인이 아님), `sessionId` 없이 관리 세션 목록을 확인하라는 안내, 옛 세션에 보내거나 보관하지 말라는 안내, 열린 내 결정 수와 원장 카드 수.
- 카드 수: 보드 스냅샷의 `decisionCount`와 `trackedDecisions.items.length`. 10초 안에 못 세거나 실패하면 그 줄을 뺀다(교체는 계속).
- 언어: 교체를 요청한 보드 언어.

### 호스트 추가 시작 지시(`readBootstrapExtra`)

- 위치: 플러그인 데이터 폴더(`scope.json`과 같은 폴더)의 `coordinator-start.md`.
- 새 코디네이터를 만들 때마다 읽는다. 첫 생성에도 붙는다.
- 일반 파일이 아니거나, 없거나, 읽지 못하거나, 정리 뒤 비면 무시한다. 열기 전에 일반 파일인지 확인한다(이름 붙은 파이프로 교체가 멈추지 않게).
- 앞 16 KiB만 읽고, CRLF를 LF로 바꾸고, 탭·줄바꿈을 뺀 C0·C1 제어 문자, 양방향 제어 문자, BOM을 지운다. 4,000 코드 포인트로 자르고, 잘렸으면 프롬프트 끝에 그 사실을 적는다.
- 프롬프트 맨 끝에 "호스트 관리자가 둔 추가 시작 지시" 머리 줄과 함께 붙인다.

### 옛 코디네이터 읽기(`server/coordinator.ts`)

- `read_board_conversation`에 `sessionId`가 있고, 그 ID가 `retiredCoordinator(scope)`(현재 코디네이터가 보드가 교체로 만든 세션일 때의 `createdCoordinator.previous`)이며 부른 세션이 현재 코디네이터이면, 관리 범위와 상관없이 이 호스트의 그 세션 기록을 읽는다. 결과에 `previousCoordinator: true`를 붙인다. 닫힌 세션도 캐시에 기대지 않고 Paseo에 저장된 기록을 다시 읽는다(닫히거나 오류 난 코디네이터의 교체가 인계가 가장 필요한 경우). 기록을 읽지 못하면 빈 결과 대신 두 언어 오류를, 옛 세션이 아직 진행 중이면 빈 기록과 함께 두 언어 안내(`note`)를 돌려준다.
- 그 밖의 세션은 지금처럼 관리 세션만 읽는다. 도구의 이름, 설명, 입력 형식은 그대로다.

### 옛 코디네이터 보관

- RPC `board.retired-coordinator`(입력 없음) → `{ retired: { id, archivable, reason?: "running" | "waiting" } | null }`.
- RPC `board.archive-retired-coordinator`(`{ sessionId }`) → `{ ok }`. 교체와 같은 순서 큐에서 돈다.
- 보이는 조건: `retiredCoordinator(scope)`가 있고, 그 세션이 있고 보관되지 않았으며, 보드가 만든 코디네이터(메타데이터 `coordinator-board/operating-session`)다. 사람이 손으로 지정했던 세션은 Paseo에서 사람이 정리한다.
- 보관 가능 조건(`retiredState`): 상태가 `running`·`initializing`이 아니고 진행 중인 턴이 없으며(아니면 `running`), 대기 중인 권한 요청이 없고 `attentionReason`도 `permission`이 아니다(아니면 `waiting`, `canReceiveBoardInput`과 같은 이중 확인).
- 보관 전에 같은 조건을 다시 읽는다. ID가 맞지 않거나 상태가 바뀌었으면 두 언어 오류로 거절한다.

### 화면

- `client/coordinator-replace.tsx`의 확인 문구에 두 언어 안내 한 문장. 보드 상단의 교체 칸(보드 업데이트 안내, 연결 끊김 안내)도 같은 컴포넌트다.
- `client/retired-coordinator.tsx`: 설정의 운영 세션 교체 칸 아래에 설명 한 줄, **옛 코디네이터 <ID 앞 8자>**, **열기**, **보관**, 꺼졌을 때 **다시 확인**과 이유.

## 3. 경계와 실패 처리

- 카드 수 읽기 실패·지연: 줄을 뺀다.
- 추가 지시 파일 문제: 무시한다.
- 새 세션은 첫 프롬프트로 곧바로 도구를 부를 수 있지만, 담당자 전환은 생성 확인 뒤에 일어난다. 그 사이 `pendingCoordinator`인 세션의 도구 호출은 "아직 지정 전, 잠시 뒤 다시 부르라"는 두 언어 오류를 받고(읽기 범위는 넓히지 않음), 시작 지시에도 재시도 안내 한 줄이 있다.
- 생성 요청이 끊겨도 재시도는 같은 ID와 키로 같은 세션을 찾는다(기존 동작). 재시도 때 프롬프트 내용이 달라도 데몬이 같은 생성으로 본다.
- 사람이 다른 코디네이터를 지정하면 `retiredCoordinator`가 `null`이 되어 읽기 예외와 보관 줄이 함께 사라진다.
- 보관된 옛 코디네이터는 읽을 수 없다는 두 언어 오류를 돌려준다.

## 4. 요구사항과 시험

| 요구 | 내용 | 시험 |
|---|---|---|
| R1 | 옛 코디네이터도 추가 지시도 없으면 첫 프롬프트가 없다 | `test/coordinator-bootstrap.test.ts` "with no coordinator to take over from…", "a first coordinator starts empty…", `test/lifecycle.test.ts`의 기존 `prompt` 없음 검사 |
| R2 | 인계 프롬프트는 머리말, 보드 글 표시, 옛 ID, 읽기 도구, 카드 수를 두 언어로 담는다 | "the %s handover prompt is marked as board text…" |
| R3 | 카드 수를 못 세면 줄을 빼고 교체는 계속한다 | "an unknown card count…", "a failing card count still replaces…" |
| R4 | 교체는 생성 요청에만 프롬프트를 담고 따로 보내지 않으며 옛 세션을 보관하지 않는다 | "a replacement creates the new coordinator with the handover…" |
| R5 | 추가 지시 파일은 선택이며 정리·상한을 거쳐 맨 끝에 붙는다 | "host instructions go last…", "host instructions lose control…", "the host instruction file is optional…" |
| R6 | 보관 줄은 보드가 만들고 교체로 은퇴시킨 코디네이터만, 진행 중·권한 대기(`attentionReason` 포함)면 꺼진다 | "only the coordinator a board replacement retired…", "a running or waiting retired coordinator…", "a coordinator the person picked by hand…" |
| R7 | 보관은 사람이 누를 때만, 조건을 다시 확인한 뒤 | "settings offer the retired coordinator…", "after the person picks another coordinator…" |
| R10 | 지정 전 도구 호출은 구분된 두 언어 오류, 시작 지시에 재시도 안내 | "a board tool called from the first prompt before the switch…", `test/lifecycle.test.ts` 준비 중 세션 거절 |
| R8 | 새 코디네이터만 바로 앞 코디네이터를 읽고(닫힌 세션은 다시 읽기, 못 읽으면 두 언어 안내), 다른 비관리 세션은 여전히 못 읽는다 | "the new coordinator can read the coordinator it replaced…", "a closed previous coordinator's record is fetched…", "an unreadable previous record is reported…" |
| R9 | 확인 문구와 설정 줄이 두 언어로 보인다 | 지어낸 데이터로 넓은 화면·390px, 한·영 화면 확인 |

## 5. 버린 설계

- 카드 수를 화면이 RPC 입력으로 보내기: 서버가 같은 스냅샷에서 세는 편이 계약을 늘리지 않고 값도 믿을 수 있다.
- 읽기 예외를 새 도구로 만들기: 도구 정의 지문이 바뀌어 모든 코디네이터에 교체 안내가 뜬다. 같은 도구의 `sessionId`로 충분하다.
- 옛 코디네이터 목록을 여러 개 남기기: 바로 앞 하나만 있으면 인계가 되고, 읽기 예외도 좁게 유지된다.

## 6. 열린 질문 (제안 답)

- 보관 줄을 보드 상단에도 둘까? (제안: 아니요. 교체 직후에는 새 세션이 읽는 중이라 서두를 필요가 없고, 설정 한 곳이면 충분하다.)
