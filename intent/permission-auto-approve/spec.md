# Spec: 읽기 전용 셸 요청 자동 승인

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 승인

## 1. 범위

플러그인 서버가 새 권한 요청 훅에서, 사람이 켠 규칙에 따라 셸 도구 요청 하나에 한 번 허용으로 답하는 길 하나. 설정 스위치, 판단, 호스트 확인, 기록, 화면 표시를 포함한다.

이 폴더를 만든 이유: "대기 중인 요청에 답하는 길"이라는 경계가 바뀌고, RPC 계약(`shared/contract.ts`의 스냅샷)과 플러그인 데이터 파일이 하나 늘어난다.

## 2. 동작 계약

### 2.1 설정

- 호스트 설정 `permission-auto-approve`(버전 1): `{ readOnlyShell: boolean }`, 기본 `false`.
- 사람이 설정 화면의 스위치로만 바꾼다. 플러그인 서버는 SDK가 주는 읽기 전용 접근으로 읽는다. 코디네이터 도구에 이 값을 읽거나 쓰는 기능을 두지 않는다.
- 읽을 수 없거나 값이 `true`가 아니면 꺼짐으로 본다.

### 2.2 답하는 때

`agent.permission.before` 훅 하나에서만 판단한다. 이 훅은 그 호스트의 세션에 새 요청이 생겼을 때 온다. 다시 띄워 복원된 요청, 다른 호스트의 세션, 내부 세션에는 오지 않으므로 그런 요청은 사람에게 남는다. 타이머나 스냅샷 조회에서 답하지 않는다.

### 2.3 조건 (위에서부터, 하나라도 아니면 아무것도 하지 않는다)

1. 호스트가 Windows가 아니다.
2. 스위치가 켜져 있다.
3. 같은 (세션, 요청)이 규칙의 기록에도, 사람의 응답 기록(`answered-requests`)에도 없다. 두 기록 가운데 하나라도 읽을 수 없으면 답하지 않는다.
4. 세션을 다시 읽었을 때 그 요청이 아직 대기 중이다. 판단은 훅이 실어 온 요청이 아니라 다시 읽은 요청으로 한다. 보관됐거나 내부 세션이면 답하지 않는다.
5. 요청이 확인된 셸 요청이다(2.4).
6. 글자 판단을 지난다(2.5).
7. 세션이 이 호스트에서 보드가 관리하는 프로젝트의 세션이고 코디네이터가 아니다(지정된 코디네이터, 보드가 만든 코디네이터 모두 제외).
8. 호스트 확인을 지난다(2.6).
9. 보내기 직전에 스위치가 여전히 켜져 있고 훅이 취소되지 않았다.

### 2.4 확인된 셸 요청

Paseo 호스트 코드에서 형식과 효과를 확인한 것만 대상이다.

| 실행기 | 도구 이름 | 판단하는 글자 | 요청이 알리는 작업 폴더 |
|---|---|---|---|
| Claude Code | `Bash` | `input.command` | 없음 |
| Codex | `CodexBash` | `input.command` | `input.cwd`(절대 경로일 때) |

- `kind`가 `tool`, `detail.type`이 `shell`이어야 한다.
- 요청이 자기 선택지(`actions`)를 가지면 대상이 아니다. 그런 요청에서 평범한 허용이 무엇을 뜻하는지 확인하지 않았다.
- Claude Code: `detail.command`가 `input.command`와 같아야 하고, 입력의 키가 확인한 셋(`command`, `description`, `timeout`)뿐이어야 한다. 그 밖의 키(백그라운드 실행, 샌드박스 끄기, 나중에 생길 키)는 값과 상관없이 사람에게 간다.
- Codex: 요청은 argv 전체를 한 줄로 싣는다. 그 줄이 `sh|bash|zsh`(`/bin/`, `/usr/bin/` 포함) + `-lc` 또는 `-c` + 스크립트 하나의 꼴이면 보드의 토크나이저로 읽은 세 번째 낱말을 스크립트로 쓴다. 표시용으로 따옴표를 잘라 낸 `detail.command`는 쓰지 않는다. Codex 앱 서버는 이 줄을 argv를 셸 인용으로 이어(shlex) 만들므로(Codex 공개 소스에서 확인), POSIX 토크나이저로 읽으면 argv가 그대로 나온다. 시험이 그 꼴의 줄을 고정한다. 명령이 없는 승인(네트워크 승인 등)은 셸 요청이 아니라 대상이 아니다.
- 응답은 늘 `{ behavior: "allow" }`다. 두 실행기 모두 이 응답이 원래 입력을 그 한 번만 실행한다. 바꾼 입력, 지속 권한, 선택지 ID를 싣지 않는다.
- 다른 실행기와 다른 도구는 목록에 더하기 전까지 사람에게 간다. ACP 실행기(Cursor 등)와 OpenCode의 요청은 자기 선택지를 가지므로 위 조건에서도 걸린다.

### 2.5 글자 판단 (`readOnlyShellPlan`, 파일시스템을 보지 않는다)

- 스크립트 길이 4,000자 이하, 읽는 경로 64개 이하.
- 줄바꿈과 탭을 뺀 제어 문자와 `#`가 없다. 셸마다 주석이 시작되는 조건이 달라, 보드가 건너뛴 주석이 실제로는 명령일 수 있기 때문이다.
- 보드의 토크나이저가 끝까지 읽는다(묶음, 중괄호, 프로세스 치환, 백그라운드 실행, ANSI-C 인용은 실패).
- 어떤 명령에도 파일 리디렉션(`>`, `>>`, `<`, `2>` 등), 헤어닥, here-string이 없다. 파일을 건드리지 않는 `2>&1`과, 출력을 정확히 `/dev/null`로 버리는 리디렉션(`2>/dev/null`, `>/dev/null`, `&>/dev/null`, 덧붙이기 꼴 포함)은 허용한다. 대상 글자가 `/dev/null`과 한 글자라도 다르거나(`/dev/null/x`, `/dev/../dev/null`), `/dev/null`에서 읽는 꼴(`<`, `<>`)이면 리디렉션으로 본다.
- 어떤 낱말에도 명령 치환, 변수 확장, 글롭이 없다.
- 따옴표 밖에 일부 셸만 확장하는 문자가 없다: 낱말 맨 앞의 `=`(zsh가 명령의 경로로 바꿈), `^`와 낱말 중간의 `~`(확장 글롭). 따옴표 안의 정규식(`'^import'`)은 그대로 통과한다.
- 분류기의 최고 위험이 `read`다. 쓰기, 네트워크, 코드 실행, 삭제, 알 수 없음, 민감한 읽기, 작업 폴더 밖 읽기가 하나라도 있으면 아니다. 환경 변수 앞붙임, `eval`, `env`, `command`, `sudo`는 여기서 걸린다.
- 모든 명령이 규칙의 목록에 있다: `ls cat head tail wc sort uniq rg grep find sed awk readlink stat file sips echo pwd`와 `cd`. 이 목록은 분류기의 읽기 목록과 따로 둔다. git은 없다. `printf`도 없다: bash의 `printf`는 형식 문자열(`%n`)로 셸 변수에 값을 쓸 수 있어, 같은 요청의 뒤 명령이 바뀐 `PATH`로 찾아질 수 있다.
- 옵션이 피연산자 뒤에 오지 않는다(`head a.txt -n ../b.txt`). 분류기는 GNU 도구처럼 옵션을 어디서든 읽지만, BSD 도구(macOS)는 첫 피연산자에서 옵션 읽기를 멈추고 뒤의 낱말을 모두 파일로 읽는다. 옵션이 피연산자 뒤에 없을 때만 두 읽기가 같다. `--` 뒤의 낱말, `find`의 식, `echo`의 인자는 해당하지 않는다.
- 이름과 메타데이터를 보는 명령(`ls find stat readlink file`)에 링크를 따라가는 옵션(`-L`, `-H`, `--dereference`)이 없다.
- `tail`에 따라가기 옵션(`-f`, `-F`, `--follow`)이 없다(끝나지 않아 세션이 시간 제한까지 기다린다). `rg`에 압축 파일 검색 옵션(`-z`, `--search-zip`)이, `file`에 압축 안을 들여다보는 옵션(`-z`, `-Z`, `--uncompress`)이 없다(`PATH`의 해제 프로그램을 실행한다).
- `cd` 대상은 절대 경로이거나 `./`로 시작한다. 맨 이름의 상대 경로는 `CDPATH`로 다른 폴더를 가리킬 수 있다.
- 내용을 읽는 명령의 대상 경로(작업 폴더 아래 부분)에 `.`으로 시작하는 이름이 없다. 예외는 관례상 비밀을 담지 않는 몇 개뿐이다: `.gitignore`, `.gitattributes`, `.editorconfig`, `.github`, `.nvmrc`. 이름 목록은 완전할 수 없어서(도구 설정, 상태 파일, 로그인 파일은 계속 새 이름이 생긴다) 점 이름은 허용 목록으로 다룬다. 이름만 보는 명령(`ls .git`)은 그대로 통과한다.
- 모든 낱말(경로가 아닌 인자 포함)에 민감한 이름이 없다(`guardedWord`). 카드 표시용 목록에 더해 `id_*`, 비밀·비밀번호·토큰으로 시작하는 이름, 자격 증명 낱말이나 `.env`, `tfstate`가 들어간 이름, `auth.json`, 서비스 계정 JSON, `kubeconfig`, `.config/gh`, `.docker`, 키체인, 셸 기록 파일, 키 저장소 확장자(`p12`, `keystore` 등)를 본다.
- 요청이 작업 폴더를 알리지 않으면(Claude Code) 읽는 경로와 `cd` 대상이 모두 절대 경로다.

### 2.6 호스트 확인 (`hostAllows`)

- 세션의 작업 폴더(세션을 만들 때의 폴더)를 실제 경로로 푼다. 루트이거나 홈 폴더이거나 홈 폴더의 위면 거절한다.
- 작업 폴더가 홈 폴더의 점 폴더(`~/.config` 등)나 `~/Library` 아래면 거절한다. 그런 곳은 일하는 폴더가 아니라 설정과 로그인 데이터가 있는 곳이다. 예외는 Paseo의 워크트리 폴더(`<Paseo 홈>/worktrees` 아래) 하나다. 보드가 관리하는 작업 세션은 대개 여기서 돌고, 그 아래는 저장소 체크아웃뿐이다.
- 요청이 알린 작업 폴더가 있으면 실제 경로가 세션 작업 폴더 안이어야 한다.
- 읽는 경로와 `cd` 대상을 하나씩 푼다. 경로는 구성 요소별로 걷는다: 링크는 그 자리에서 따라가고 `..`은 링크가 가리킨 폴더에서 올라간다. 글자로 `..`을 먼저 정리하지 않는다.
- 푼 경로가 세션 작업 폴더 안이어야 한다. 민감한 이름 검사는 작업 폴더 아래 부분만이 아니라 푼 전체 경로에 한다.
- 내용을 읽는 명령의 대상은 일반 파일이어야 한다. 폴더, 장치, 파이프는 거절한다. 이름을 보는 명령의 대상은 파일이나 폴더, `cd` 대상은 폴더다.
- 내용을 읽는 대상은 이름이 하나뿐이어야 한다(하드 링크 수 1). 작업 폴더 안의 이름이 밖에 있는 파일의 두 번째 이름일 수 있다. 푼 경로의 작업 폴더 아래 부분에 대해 점 이름 검사도 다시 한다(링크가 점 이름을 가릴 수 있다).
- 존재하지 않거나 풀 수 없으면 거절한다.

`cd`는 실패할 수 있으므로 분류기는 뒤 명령의 경로를 옮기기 전 폴더와 옮긴 폴더 양쪽에서 본다. 따라서 `cd ./src && cat index.ts`는 `index.ts`가 양쪽에 있을 때만 통과한다.

### 2.7 응답과 기록

- 응답은 사람의 버튼과 같은 함수(`shared/permission-responder.ts`의 `createResponder`)로 보낸다. 보내기 전에 세션을 다시 읽어 요청이 대기 중일 때만 보내고, 같은 요청에 두 번 보내지 않는다.
- 기록 파일: 플러그인 데이터 폴더의 `permission-auto-approvals.json`, `{ version: 1, entries: [...] }`. 임시 파일에 쓴 뒤 이름을 바꾸고 `0o600`을 준다. 최근 100건, 14일.
- 항목: `session`, `request`, `at`, `title`(세션 제목), `projectId`, `summary`(명령 이름 묶음), `command`(200자까지), `state`.
- `state`: 응답을 보내면 `sent`. `agent.permission.after` 훅이 그 요청의 결과를 알리면 허용일 때 `allowed`, 아니면 `other`(같은 순간 다른 곳에서 거절한 경우).
- 서버는 호스트 설정을 쓸 수 없어 `answered-requests` 설정에 적지 못한다. 대신 규칙은 그 설정을 읽어 사람이 이미 답한 요청을 건너뛰고, 자기 기록으로 자기 중복을 막는다. 사람의 버튼은 질문과 계획에만, 규칙은 셸 도구 요청에만 답하므로 두 길이 같은 요청에 답하는 일은 없다.

### 2.8 화면과 RPC

- 스냅샷에 `permissionAutoApprovals: { supported, entries }`가 더해진다(선택 항목). `entries`는 관리 프로젝트의 기록이고 최신순이다.
- 설정: 스위치, 안내 문단, Windows 호스트일 때의 이유, 최근 자동 승인 목록(다섯 건씩 펼침).
- 세션 카드: `읽기 전용 자동 승인 · 명령 요약 · 시각` 한 줄과 건수. 펼치면 다섯 건까지.

## 3. 경계와 실패 처리

- 판단 중 예외는 모두 "답하지 않음"이다. 훅은 실패를 밖으로 던지지 않는다.
- 응답 전송이 실패하면 기록하지 않는다. 다시 보내지 않는다.
- 응답을 보냈지만 요청이 목록에서 사라지는 것을 확인하지 못해도 기록은 남고(`sent`), 다시 보내지 않는다.
- 기록 파일이 깨져 읽을 수 없으면 규칙은 아무것도 답하지 않고 화면에는 빈 목록을 보인다.
- 확인과 실행 사이에 파일이 바뀔 수 있다. 규칙은 이 틈을 막지 못한다. 바꿔치려면 같은 세션이 그 사이에 링크를 만들어야 하는데, 링크를 만드는 명령은 쓰기라 자동 승인되지 않고 사람에게 간다(이미 허용된 다른 쓰기 수단이 있는 세션은 예외). 설정의 안내 문단에 이 한계를 적는다.
- 규칙은 명령 글자와 경로만 본다. 호스트의 별칭, 셸 함수, `PATH`가 가리키는 실행 파일, 셸 옵션(확장 글롭 등), 도구의 환경 변수 설정(예: 검색 도구의 설정 파일)은 확인하지 못한다. 이 한계는 README와 OVERVIEW에 적는다.
- Paseo의 권한 알림은 훅보다 먼저 나간다. 자동 승인된 요청에도 알림이 온다.
- 알려진 한계: ACP 실행기(Cursor 등)는 대상이 아니다. 이유는 둘이다. ACP 요청은 실행할 글자(`input.command`)를 싣지 않고 도구 상태에서 만든 표시용 `detail`만 가진다. 선택지를 고르지 않은 허용은 한 번 허용이 없을 때 항상 허용으로 넘어갈 수 있다. 후속 작업은 잡지 않는다(유지관리자 판단). OpenCode도 명령의 출처를 확인하지 않아 대상이 아니다.

## 4. 요구사항과 시험

시험 파일은 `test/permission-auto-approve.test.ts`다.

| 요구 | 내용 | 시험 |
|---|---|---|
| R1 | 설정은 호스트 설정이고 기본 꺼짐. 꺼져 있으면 세션을 읽지도, 답하지도, 기록하지도 않는다 | "the setting is a host setting that starts off", "with the rule off nothing is read and nothing is answered" |
| R2 | 조건을 채운 요청에 평범한 허용이 한 번 나가고 기록되며, 같은 요청에 다시 답하지 않는다 | "with the rule on a read-only request is allowed once, recorded and never answered twice" |
| R3 | 리디렉션, 헤어닥, 치환, 확장, 글롭, 주석, 제어 문자, 환경 변수 앞붙임, `eval`이 사람에게 간다 | "redirection, substitution, expansion and an environment prefix send the request to a person" |
| R4 | 이전 분류기를 우회했던 옵션 입력이 사람에게 간다 | "the options that slipped past an earlier classifier stay with a person" |
| R5 | git과 `printf`는 읽기로 분류돼도 대상이 아니다 | "git is not approved by the rule, even for a read", "printf is not approved by the rule" |
| R6 | 민감한 이름은 경로가 아닌 인자에 있어도 거절한다 | "a sensitive name anywhere in the request is refused, path or not" |
| R7 | 호스트에서 링크를 풀어 작업 폴더 밖, 민감한 대상, 내용 명령의 폴더 대상, 없는 파일, 링크 뒤의 `..`을 거절한다. 홈 폴더 이상인 작업 폴더를 거절한다 | "the host resolves each path and refuses links that leave the folder, ..." |
| R8 | 작업 폴더를 알리지 않는 실행기에서는 절대 경로만 통과한다. Codex의 셸 감싸기는 토크나이저로 읽는다 | "a provider that does not say where the command runs gets only absolute paths approved", "Codex's shell wrapper is read with the board's tokenizer ..." |
| R9 | 확인된 실행기와 도구의 셸 요청만, 자기 선택지가 없는 것만 대상이다 | "only checked shell requests without choices of their own are considered" |
| R15 | 내용을 읽는 대상의 점 이름(허용 목록 밖), 더한 민감 이름, 하드 링크, 홈 폴더의 점 폴더와 Library 아래 작업 폴더를 거절하고 Paseo 워크트리는 통과한다 | "a sensitive name anywhere in the request is refused, path or not", "the host resolves each path ..." |
| R16 | 맨 이름의 상대 `cd`, `tail` 따라가기, `rg` 압축 검색을 거절한다. Claude Code 입력은 확인한 키만 받는다 | "a bare relative cd, following a file and searching compressed files are refused", "only checked shell requests ..." |
| R17 | Codex의 shlex 꼴 줄을 스크립트로 되읽는다 | "a Codex command line in shlex form is read back into the script it carries" |
| R18 | 판단 도중 스위치를 끄거나 훅이 취소되면 보내지 않는다. 플러그인은 설정이 읽히고 참일 때만 켜짐으로 본다 | "a switch turned off while the request is being judged, or a cancelled hook, sends nothing", "the plugin treats the switch as on only when the host setting is readable and true" |
| R19 | 피연산자 뒤에 쓴 옵션을 거절한다 | "an option written after an operand is refused" |
| R10 | 코디네이터, 관리 밖 세션, 다른 호스트 세션, 보관된 세션, 읽을 수 없는 기록, Windows 호스트에서 답하지 않는다 | "the session, the record and the host each stop the rule", "a coordinator's own request and a session outside the managed projects ..." |
| R11 | 응답 호출은 한 곳, 서버에서 쓰는 곳은 규칙뿐, 규칙은 훅 한 곳에서만 불리고 타이머·메시지 전송·지속 권한이 없다 | "the plugin wires the rule to the hook for a new request and to nothing else", `test/pending-requests.test.ts`의 "one shared responder answers a waiting request, ..." |
| R12 | 기록은 요청마다 하나, 상태가 바뀌고, 오래된 것과 넘치는 것이 빠진다 | "the record keeps one entry per request, ..." |
| R13 | 카드와 설정의 문구가 두 언어로 나온다 | "the card line and the setting text read in both languages" |
| R14 | 넓은 화면과 390px, 한국어와 영어에서 설정, 이력, 사람에게 온 요청 카드를 확인한다 | 지어낸 예시 데이터로 화면 확인 |

## 5. 버린 설계

- **스위치를 보드의 범위 파일(`scope.json`)에 두기**: 그 파일은 서버가 쓴다. 서버가 쓸 수 있는 값이면 서버의 다른 경로(코디네이터 도구 포함)가 켤 수 있다. 호스트 설정은 서버가 읽기만 한다.
- **훅이 실어 온 요청으로 판단**: 훅과 응답 사이에 요청이 바뀌거나 사라질 수 있다. 다시 읽은 요청으로 판단한다.
- **`detail.command`로 판단**: Codex의 `detail.command`는 표시용으로 감싼 셸을 정규식으로 벗기고 양끝 따옴표를 잘라 낸 값이라 실제 스크립트와 글자가 다를 수 있다.
- **`realpath` 한 번으로 경로 풀기**: 구현에 따라 `..`을 글자로 먼저 정리해, 링크 뒤의 `..`이 실제와 다른 파일을 가리킨다. 구성 요소별로 걷는다.
- **폴더를 훑어 민감한 파일이 없는지 확인한 뒤 폴더 검색을 승인**: 훑는 범위에 상한이 필요하고 상한을 넘는 폴더에서 결과가 달라져 예측하기 어렵다. 확인과 실행 사이의 틈도 커진다.
- **분류기의 읽기 목록을 그대로 승인 목록으로 쓰기**: 카드 표시를 넓히는 변경이 승인 범위를 함께 넓힌다.
- **`/dev/null` 예외를 규칙에만 두기**: 규칙이 분류기의 쓰기 판정을 뒤집으면 카드와 규칙이 같은 명령을 다르게 말한다. 그래서 파서가 정확히 `/dev/null`로 버리는 출력을 리디렉션 대상에서 빼고, 카드의 분류도 그 출력을 쓰기로 표시하지 않는다(유지관리자 판단으로 추가).

## 6. 열린 질문 (제안 답)

- **Claude Code의 상대 경로**: 요청에 작업 폴더가 없어 지금은 절대 경로만 통과한다. Claude Code는 작업 폴더 안의 읽기 명령을 스스로 허용하는 경우가 많아, 이 규칙이 실제로 줄이는 요청은 Codex 쪽이 더 많을 것이다. (제안: 지금대로 둔다. 호스트가 요청에 작업 폴더를 싣게 되면 그때 넓힌다.)
- **폴더 전체 검색과 `cd 폴더 && cat 파일`**: 자주 쓰이지만 지금은 사람에게 간다. (제안: 써 본 뒤 필요하면 별도 intent로 다룬다.)
- **Windows**: 지금은 규칙을 쓰지 않는다. (제안: Windows 셸 문법을 읽는 분류가 생기기 전에는 그대로 둔다.)
- **자동 승인하지 않은 이유를 카드에 보이기**: (제안: 별도 일.)
