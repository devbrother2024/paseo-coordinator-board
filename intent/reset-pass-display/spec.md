# Spec: account-usage.json의 resetPasses 형식과 계정 카드 표시

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #59)

## 1. 범위

`account-usage.json`의 보고에 선택 칸 `resetPasses`를 더하고, 서버가 읽어 설정 응답에 싣고, 계정 카드가 보인다. 플러그인 데이터 파일 형식(`account-usage.json`)과 설정 RPC 출력이 바뀌어 이 문서를 작성한다.

## 2. 동작 계약

### 형식

보고(`reports[]`의 항목)마다 선택 칸 `resetPasses`를 받는다.

```json
"resetPasses":[{"id":"weekly","label":"Weekly reset","left":2,"expiresAt":["2026-12-11T07:00:00Z"],"note":"Restores the weekly limit"}]
```

| 필드 | 형식 | 상한 |
|---|---|---|
| `id` | 앞뒤 공백을 뺀 비지 않은 문자열 | 64자 |
| `label` | 앞뒤 공백을 뺀 비지 않은 문자열 | 64자 |
| `left` | 0 이상 정수 | 9999 |
| `expiresAt` | 시간대가 붙은 ISO 시각의 배열 | 16개 |
| `note` | 선택. 비었거나 공백뿐이면 생략한 것으로 본다 | 200자 |

- 보고당 앞에서 16개까지만 본다.
- 항목별로 검사한다. 틀린 항목만 버리고 보고의 나머지는 그대로 쓴다.
- `resetPasses`가 배열이 아니거나 유효한 항목이 하나도 없으면 보고는 남기고 초기화권만 없는 것으로 본다.

### Paseo 측정 계정에 덧붙이기

- 이 호스트에 설치된 실행기 가운데 Paseo 보고에 읽을 수 있는 사용량이 있는 실행기는, 같은 `providerId`의 파일 보고에서 `resetPasses`만 가져와 Paseo 보고에 덧붙인다. Paseo의 `windows`, `balances`, `fetchedAt`은 바꾸지 않는다.
- 짝짓기: 그 실행기에 Paseo 계정 하나, 파일 보고 하나면 `label`과 무관하게 짝짓는다. 아니면 `label`이 양쪽에서 정확히 하나씩 같을 때만 짝짓는다. 애매하면 붙이지 않는다.
- 덧붙인 초기화권에는 파일 보고의 `fetchedAt`을 `resetPassesFetchedAt`으로 함께 싣는다.
- Paseo 사용량이 없는 실행기는 지금처럼 파일 보고가 표시 전용 카드가 되며, 초기화권도 그 카드에 함께 실린다.
- 이 병합은 설정 응답에만 쓴다. 배정 판단은 병합 전 Paseo 보고로 끝난다.

### 표시

- 초기화권마다 한 줄: 이름(`label`), 남은 장수("2장 남음" / "2 left"). 0장은 "없음" / "None"을 흐리게 보인다.
- 남은 장수가 있으면 아직 지나지 않은 가장 가까운 만료와 남은 시간을 보인다("가장 가까운 만료 … · 16일 1시간 남음"). 남은 시간은 기존 초기화 카운트다운과 같은 함수이고, 1분 안은 "곧 만료" / "expires soon"이다.
- 지난 만료일은 표시에서만 뺀다. 남은 장수는 파일 값을 그대로 따른다. 만료가 모두 지났으면 만료 줄을 숨긴다.
- `note`가 있으면 그 아래 작게 보인다.
- `resetPassesFetchedAt`이 있으면 초기화권 칸에 그 조회 시각을 따로 보인다. 계정 측정의 "이전 측정"과 같은 기준(15분)으로 오래되면 "초기화권 이전 보고 …" / "Reset passes last known …"로 바꾸고 장수를 흐리게 보인다. 표시 전용 카드는 카드의 조회 시각을 함께 쓴다.
- 설정 화면을 연 동안 카운트다운 시계는 초기화 시각, 남은 만료와 함께 초기화권이 오래되는 시각에도 깨어난다. 세는 시각이 하나도 없어도 화면을 연 채로 "이전 보고"로 바뀐다.
- 칸 아래에 표시 전용이며 배정에 쓰지 않는다는 안내를 두 언어로 보인다.

## 3. 경계와 실패 처리

- 파일 읽기: 심볼릭 링크를 따르지 않고, 128KiB를 넘거나 JSON·`version`이 틀리면 파일 전체를 무시한다(이전과 같음).
- 예전에는 모든 설치 실행기에 Paseo 사용량이 있으면 파일을 읽지 않았다. 이제 초기화권 때문에 설정을 열 때 늘 읽는다. 설치된 실행기가 없으면 읽지 않는다.
- 호환
  - 옛 파일(`resetPasses` 없음): 화면과 동작이 이전과 같다.
  - 옛 보드가 새 파일을 읽을 때: 모르는 칸은 스키마가 버리므로 보고는 이전처럼 보이고 초기화권만 안 보인다.
  - 설정 RPC 출력의 두 필드(`resetPasses`, `resetPassesFetchedAt`)는 선택 항목이다. 화면과 서버는 한 플러그인으로 함께 배포된다.

## 4. 요구사항과 시험

| R | 내용 | 시험 |
|---|---|---|
| R1 | 항목별 검사: 상한·형식이 틀린 항목만 버리고 보고 유지. 빈·공백 `note`는 항목을 두고 생략. 배열이 아니거나 유효 항목이 없으면 초기화권 없이 보고 유지 | [`test/reset-passes.test.ts`](../../test/reset-passes.test.ts)의 `a malformed reset pass is dropped and the rest of the report is kept` |
| R2 | Paseo 측정 실행기에 초기화권과 파일 보고 시각만 덧붙이고 창·잔액은 그대로. 표시 전용 카드는 생기지 않음 | 같은 파일의 `passes reach a provider Paseo measures without the file replacing its measurements` |
| R3 | 짝짓기: 1:1은 `label` 무관, 여럿이면 `label` 정확 일치만. 애매한 경우, 설치되지 않은 실행기, 초기화권 없는 보고는 아무것도 붙이지 않음 | 같은 파일의 `passes are attached only when the account they belong to is clear` |
| R4 | 표시 문구: 한·영 장수, 가장 가까운 남은 만료, 지난 만료 제외, 0장 "없음", 1분 안 "곧 만료" | 같은 파일의 `the card shows the count and the nearest expiry still ahead` |
| R5 | 덧붙인 초기화권은 자기 보고 시각으로 신선도를 따로 판정하고, 표시 전용 카드는 카드 시각을 씀 | 같은 파일의 `passes on a measured account show their own report time and turn old with it` |
| R6 | 기존 표시 전용 카드 동작(빈칸 채우기, 측정 시각 보존, 깨진 파일·큰 파일·심볼릭 링크 무시) 유지 | [`test/usage-routing.test.ts`](../../test/usage-routing.test.ts)의 `host readings fill only configured provider gaps and preserve the original observation time` |
| R7 | 넓은 화면·390px, 한·영에서 초기화권 칸과 이전 보고 줄이 겹치지 않게 보임 | 저장소 밖 react-native-web 하네스에서 지어낸 데이터로 화면 확인 |
| R8 | 세는 초기화·만료 시각이 없어도 초기화권이 오래되는 시각에 시계가 깨어나 이전 보고로 바뀜. 남은 만료도 시계가 봄 | [`test/reset-passes.test.ts`](../../test/reset-passes.test.ts)의 `the settings clock wakes when passes turn old even with nothing counting down` |

## 5. 버린 설계

- 표시 전용 카드에만 초기화권 싣기: Paseo 측정 실행기에는 보이지 않는다.
- 파일 보고를 Paseo 보고와 통째로 바꾸기: 낡은 파일 값이 새 측정을 가린다.
- 짝짓기를 `providerId`만으로 하기: 한 실행기에 계정이 여럿이면 다른 계정의 초기화권이 붙는다.
- 덧붙인 초기화권에 Paseo의 `fetchedAt`만 보이기: 낡은 파일 값이 새 측정 시각 아래 신선해 보인다.
- 틀린 항목 하나로 보고 전체를 버리기: 운영 도구의 작은 실수가 계정 카드 전체를 지운다.

## 6. 열린 질문 (제안 답)

- 0장을 숨길지: 흐리게 보인다. 초기화권이 있는 구독인데 지금 없다는 것도 정보다.
- 만료가 모두 지난 초기화권의 장수: 파일 값을 그대로 보인다. 다시 세는 일은 운영 도구가 맡는다.
