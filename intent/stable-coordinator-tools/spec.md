# Spec: 고정된 코디네이터 도구 계약과 확장 길

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #62)

## 1. 범위

코디네이터 도구의 이름과 입력 형식을 계약으로 고정하고, 도구 두 개(`read_board_guide`, `board_action`)를 더하고, 옛 도구 판정과 안내를 계약 기준으로 바꾼다. 작업 세션의 `report_to_board`는 코디네이터 도구가 아니므로 대상이 아니다.

이 폴더를 만든 이유: 코디네이터 도구 입력 형식이 바뀌고, 버린 대안을 남길 설계 갈림길이 있다.

## 2. 동작 계약

### 2.1 계약

- 계약은 코디네이터가 받는 도구의 **이름과 입력 형식**이다. 번호는 `shared/coordinator-contract.ts`의 `coordinatorContract.version`이고 지금은 1이다.
- 계약 1의 도구는 아홉 개다. 기존 일곱 개(`read_board_conversation`, `classify_board_conversation`, `plan_board_assignment`, `assign_board_worker`, `answer_board_fact`, `review_board_records`, `judge_board_pull`)의 입력 형식은 이 변경 전과 같다. 새로 `read_board_guide`, `board_action`이 들어간다.
- 지문은 도구 이름과 입력 형식만으로 만든다. 도구 설명과 제목, 입력 항목의 설명 문구는 지문에 들어가지 않는다. 키 순서와 필수 항목 이름 순서도 지문을 바꾸지 않는다.
- `coordinatorContract.compatibleFrom`은 지금 보드와 함께 쓸 수 있는 가장 낮은 계약 번호다. 지금은 1이다. 계약을 깨는 변경은 `version`과 `compatibleFrom`을 함께 올린다. 도구를 더하기만 하는 변경은 `version`만 올린다.

### 2.2 `board_action`

입력: `{ contract: 양의 정수, action: 문자열(1~64자), input?: 열린 객체 }`. `input`의 안쪽 형식은 계약에 없다.

- `action`은 지금 설치된 보드의 기능 이름이다. 기존 도구 일곱 개가 같은 이름의 기능으로 등록된다. 도구 정의 없이 기능으로만 내는 항목(`actionOnly`)도 같은 목록에 들어간다.
- 보드는 `input`을 그 기능의 **지금 받는 형식**(`accepts`, 없으면 도구의 입력 형식)으로 검사한 뒤 그 도구의 실행 함수를 그대로 부른다. 결과는 도구를 직접 부른 것과 같다. 권한 확인(지정된 코디네이터인지, 관리 범위인지)도 그 실행 함수가 지금처럼 한다.
- 모르는 기능 이름이면 오류 결과로 쓸 수 있는 이름 목록을 준다. 형식 검사에 실패하면 오류 결과로 어긋난 항목과 그 기능의 지금 입력 형식(JSON Schema)을 준다. 오류 문구의 머리는 두 언어다.
- 새 선택 항목을 낼 때는 도구의 입력 형식(계약)을 두고 `accepts`에 더한다. 그 항목은 `board_action`으로만 받는다.
- 코디네이터가 어떤 보드 도구를 불렀는지 타임라인의 도구 이름으로 판단하는 곳(예약된 다이제스트의 완료 판정)은 `board_action`으로 부른 경우를 그 기능을 부른 것으로 센다.

### 2.3 `read_board_guide`

입력: `{ contract: 양의 정수, topic?: 문자열(1~64자) }`.

- `topic`이 없으면 계약 번호, 안내 판본, 이 대화의 도구 정의 상태(`current`, `older`, `unknown`), 쓰는 법, 기능 목록(이름, 한 줄 설명, 도구 정의가 있는지, `board_action`으로만 받는 항목)을 JSON으로 준다.
- `topic`이 기능 이름이면 그 기능의 사용법(도구 설명, 또는 따로 적은 `usage`)과 지금 입력 형식(JSON Schema)을 준다. 모르는 이름이면 오류 결과로 이름 목록을 준다.
- 안내 판본은 대화가 자기 도구 정의로는 알 수 없는 것(도구 정의 없는 기능, 도구 정의보다 더 받는 기능)의 이름과 지금 입력 형식에서 만든 짧은 해시다. 그런 것이 없으면 빈 문자열이다. 설명과 항목 설명 문구는 들어가지 않으므로 문구만 고친 업데이트는 판본을 바꾸지 않는다. 기존 도구의 설명은 줄이지 않고 그대로 둔다.
- 사람에게 보이는 화면 문구가 아니라 모델이 읽는 도구 문서이므로, 기존 도구 설명과 같이 영어로 쓴다.

### 2.4 `contract` 항목

두 도구의 `contract`는 대화가 가진 정의에 적힌 계약 번호를 되돌려 받는 자리다. 항목 설명에 "항상 N"이라고 적고, 입력 형식은 모든 양의 정수를 받는다. 계약 번호가 올라간 뒤에도 옛 정의를 가진 대화의 호출이 형식 검사에서 거절되지 않고, 보드는 그 대화가 몇 번 계약을 가졌는지 안다. 대화를 압축하면 대화 ID가 그대로라서, 이 값이 없으면 보드는 압축으로 정의가 새로워진 것을 알 수 없다.

### 2.5 대화별 기록

호스트 설정의 `toolStamps[코디네이터 ID]`에 선택 항목이 늘어난다. 옛 기록은 그대로 읽는다.

| 항목 | 뜻 |
|---|---|
| `session`, `fingerprint`, `at` | 지금과 같다. 대화가 처음 보드 도구를 불렀을 때의 대화 ID와 지문 |
| `contract` | 이 대화가 가진 계약 번호. 새 대화는 첫 호출 때의 번호, 그 뒤에는 `contract` 항목으로 받은 더 높은 번호 |
| `early` | 계약이 생기기 전에 기록된 대화가 나중에 계약 도구를 부른 경우. 일부 도구 정의가 계약 1보다 오래됐을 수 있다 |
| `guide` | 이 대화가 마지막으로 읽은 안내 판본. 새 대화는 빈 판본에서 시작하고, 계약 전의 기록에는 없다 |
| `noted` | 읽으라고 알린 안내 판본 |

### 2.6 옛 도구 판정과 안내

- 판정: 기록의 지문이 지금과 같으면 `current`. 대화 ID를 읽지 못하면 `unknown`. 대화가 바뀌었으면 `current`. 같은 대화이고 지문이 다르면, 기록의 계약 번호가 `compatibleFrom` 이상일 때 `current`, 아니면(번호가 없는 옛 기록 포함) `stale`.
- 화면 안내는 `stale`일 때만 뜬다. 조건(이 호스트의 Claude Code 코디네이터, 닫히거나 오류가 아닌 세션)은 지금과 같다. Claude Code인지는 아래 2.7로 판정한다.
- 화면 안내의 순서: (1) 그대로 두기. 코디네이터가 안내 도구를 읽으면 사라진다. (2) 사람이 코디네이터 세션에 `/compact`를 직접 입력. (3) 새 세션으로 교체 또는 `/clear` 직접 입력. 버튼은 **코디네이터 세션 열기**가 먼저, **새 세션으로 교체**가 나중이다.
- 도구 알림: 대화가 지금 안내 판본을 읽지 않았고(`guide`가 다름) 그 판본에 대해 알린 적이 없으면(`noted`가 다름), 보드 도구 결과에 알림을 붙인다. 글로 답하는 결과의 끝에 붙었을 때만 알린 것으로 기록한다. JSON으로 답하는 결과는 본문을 바꾸지 않으며 알린 것으로 치지 않는다. `read_board_guide` 자신의 결과에는 붙이지 않는다.
- 알림은 두 언어이고, 안내 도구를 한 번 읽으라는 것과 교체, `/clear`, `/compact`가 필요 없다는 것을 말한다.

### 2.7 실행기 판정

대화가 불러온 도구 정의를 기억하는 실행기는 Claude Code다. 판정은 실행기 ID가 아니라 그 대화를 실제로 돌리는 구현으로 한다.

- 근거: Paseo의 실행기 구현은 세션의 이어받기 정보(`persistence.metadata.provider`)에 자기 이름을 적는다. 다른 계정용 프로필처럼 ID가 다른 실행기로 띄운 Claude Code 세션에서 `persistence.provider`는 프로필 ID이고 `persistence.metadata.provider`는 `claude`인 것을 Paseo 0.17.4에서 확인했다. SDK의 실행기 목록(`ProviderSnapshotEntry`)에는 바탕 종류를 알려 주는 항목이 없다(`source`는 기본 제공인지 사용자 정의인지만 말한다).
- `conversationProvider`는 그 값이 있으면 그것을, 없으면 `persistence.provider`를 쓴다. ID의 생김새(접두사 등)로 추측하지 않는다.
- 판정에 필요한 세션 조회는 도구 호출을 기록할 때와 화면 안내를 낼 때 이미 하던 조회다. 기록이 있는 대화만 화면 판정 대상이므로, 기록이 없는 코디네이터에는 조회가 늘지 않는다.

## 3. 경계와 실패 처리

- 전송: 새 전송 경로가 없다. `board_action`으로 부른 `answer_board_fact`는 그 도구의 기존 검사와 출처 표시를 그대로 거친다.
- 기록 실패(설정 파일을 쓰지 못함, 대화 ID 조회 실패)는 도구 결과를 바꾸지 않는다. 알림도 붙이지 않는다.
- Claude Code가 아닌 실행기의 코디네이터는 기록하지 않고 알리지 않는다. 두 도구는 받는다.
- `contract` 값이 지금 계약 번호보다 크거나 정수가 아니면 기록에 쓰지 않는다.
- 이전 빌드로 되돌리면 늘어난 기록 항목은 무시된다.

## 4. 요구사항과 시험

| 요구 | 내용 | 시험 |
|---|---|---|
| R1 | 지문은 이름과 입력 형식만 본다. 설명만 바꾼 빌드는 `current`이고 화면 안내도 도구 알림도 없다 | `test/coordinator-tools.test.ts`의 `the fingerprint follows names and input shapes, not wording`, `a build that only rewords descriptions is not reported`, `test/board-guide.test.ts`의 `the guide revision follows what only board_action can reach, not wording or order` |
| R2 | 실제 코디네이터 도구의 이름과 입력 형식이 계약 스냅샷과 같다. 다르면 안내 문구와 함께 실패한다 | `test/coordinator-contract.test.ts`의 `the coordinator tool contract matches its snapshot` |
| R3 | `board_action`은 지금 받는 형식으로 검사하고 같은 결과를 낸다. 계약 밖 항목과 도구 없는 기능을 실행한다 | `test/board-guide.test.ts`의 `board_action runs an action with the installed checks`, `a field added after the contract is reachable only through board_action` |
| R4 | 경로 출처 항목을 `board_action`으로 넘겨 배정 도구의 지금 형식 검사를 통과한다 | `test/coordinator-contract.test.ts`의 `the assignment route fields pass through board_action` |
| R5 | 모르는 기능과 형식 오류는 오류 결과로 이름 목록, 어긋난 항목, 지금 형식을 준다 | `test/board-guide.test.ts`의 `board_action explains an unknown action and a rejected input` |
| R6 | 안내 도구는 기능 목록, 기능별 사용법과 지금 형식, 대화의 정의 상태를 준다. 기존 도구의 사용법은 그 도구의 설명 그대로다 | `test/board-guide.test.ts`의 `the guide lists actions and describes one`, `test/coordinator-contract.test.ts`의 `every board tool is an action, and the guide repeats the tool's own description` |
| R7 | 계약 전의 대화는 `stale`이고, 계약 도구를 부르면 교체 없이 `current`가 된다. 호환되지 않는 계약은 압축 뒤 새 번호를 받을 때까지 `stale`이다 | `test/coordinator-tools.test.ts`의 `a conversation from before the contract catches up by reading the guide`, `a broken contract stays stale until the conversation holds the new one` |
| R8 | 알림은 안내 판본마다 대화당 한 번이고, 글 결과에 붙었을 때만 기록한다 | `test/coordinator-tools.test.ts`의 `the guide note is attached once per guide revision`, `a JSON result does not count as told` |
| R9 | 화면 안내는 맥락을 덜 잃는 순서이고 두 언어다 | `test/coordinator-tools.test.ts`의 `notice wording orders the fixes from least to most context lost` |
| R10 | 보드는 세션을 다시 띄우지 않고 `/clear`, `/compact`를 보내지 않는다 | `test/coordinator-tools.test.ts`의 `the board never reloads a session, nor types /clear or /compact into one` |
| R11 | 다이제스트 완료 판정이 `board_action`으로 부른 보드 도구를 센다 | `test/digest.test.ts`의 `a board tool run through board_action counts as that tool` |
| R12 | Claude Code 프로필로 도는 코디네이터를 Claude Code로 판정한다. 다른 실행기의 프로필과, 기록 없이 이름만 닮은 ID는 판정하지 않는다 | `test/coordinator-tools.test.ts`의 `a coordinator on a Claude Code profile is judged by what the profile runs on` |

## 5. 버린 설계

- **실행기 ID 접두사로 Claude Code 프로필 판정하기.** ID는 사용자가 정하므로 `claude`로 시작해도 Claude Code가 아닐 수 있고, Claude Code 프로필이 다른 이름일 수 있다. Paseo가 적는 기록이 있어 추측할 필요가 없다.
- **안내 판본에 설명과 사용법 문구 넣기.** 문구를 고칠 때마다 운영 대화에 알림이 한 번씩 붙는다. 알림은 대화가 모르는 기능이나 항목이 생겼을 때로 한정한다.
- **계약의 입력 형식을 데이터 파일로 두고 거기서 도구 입력을 만들기.** 코드로는 계약을 바꿀 수 없게 되지만, JSON Schema를 검사 스키마로 되돌리는 과정에서 기존 도구의 형식 검사가 미세하게 달라질 수 있다. 기존 도구를 그대로 두는 쪽을 골랐고, 스냅샷 시험이 같은 일을 막는다.
- **`contract`를 정해진 값 하나만 받게 하기.** 계약 번호를 올리는 순간 옛 정의를 가진 대화의 호출이 형식 검사에서 모두 거절된다.
- **대화마다 기능별 형식 해시를 기록해 바뀐 기능을 계산하기.** 계약이 고정돼 있으므로 "지금 받는 형식에는 있고 계약에는 없는 항목"이 곧 대화가 모르는 항목이다. 기록을 늘리지 않고 같은 답을 낸다.
- **안내 도구에 설치 버전 싣기.** 버전은 릴리스 PR에서만 올라가므로 기능 PR 사이의 차이를 가리지 못한다. 안내 판본 해시가 그 일을 한다.

## 6. 열린 질문 (제안 답)

- 대화 압축이 Paseo 안의 세션에서도 같은 결과를 내는가: Claude Code 명령줄에서 확인했다. Paseo의 Claude 세션은 같은 실행 파일을 쓰므로 같을 것으로 보지만 Paseo 화면에서 직접 확인하지는 않았다. 화면 안내는 압축을 두 번째 수단으로만 적는다.
- 도구가 지연 로딩되지 않는 환경에서 새 도구가 기존 대화에 알려지는가: 확인하지 못했다. 알려지지 않으면 그 대화는 화면 안내의 두 번째, 세 번째 수단을 쓴다.
