# Spec: 명시한 배정 경로 검증과 기록

Intent: [intent.md](intent.md)
승인: 2026-11-25 유지관리자(세션)
상태: 구현됨 (PR #55)

## 1. 범위

`assign_board_worker`가 선택적 입력 하나를 받아 배정 경로의 출처를 기록한다. 코디네이터 도구 입력과 배정 기록 형식이 바뀌어 이 문서를 작성한다.

## 2. 동작 계약

- `job.routeSource`는 선택 항목이며 지원 값은 `"coordinator"`다. 생략한 호출은 기존 보드 경로로 검증한다.
- 코디네이터가 고른 `job.expectedRoute`는 대상 워크스페이스의 실행기·모델·추론 강도 목록에 있어야 한다. 제외한 실행기는 사용할 수 없고, `needsHooks`가 켜진 경우 네이티브 훅을 지원해야 한다.
- 보드에서 지정한 작업 권한 모드 또는 실행기의 권장 작업 모드를 대상 호스트에서 확인한다. `expectedModeId`가 있으면 일치해야 한다.
- 새 세션 메타데이터와 새로 저장하는 다중 호스트 배정 기록에 `coordinator` 또는 `board`를 남긴다. 예전 기록은 출처 필드 없이 읽고 기존 생성 요청으로 재시도한다.
- 배정 기록을 정리한 뒤에는 세션 ID, 호스트 ID, 요청 키와 정리 시각만 남긴다.

## 3. 경계와 실패 처리

새 배정 경로 검증에 실패하면 두 언어로 이유를 알린다. 같은 키에서 출처를 바꾸면 다른 작업으로 처리한다. 같은 요청을 재시도하면 기존 호스트와 세션의 생성 기록을 확인한다. 원격 첫 지시는 발신 세션과 호스트를 표시하고, 미확인 상태의 재시도와 권한 대기 검사는 기존 전송 경로를 따른다.

## 4. 요구사항과 시험

| R | 내용 | 시험 |
|---|---|---|
| R1 | 원격 호스트에 등록된 모델·강도 수락과 출처 저장. 입력 생략 시 보드 추천과 비교 및 출처 저장. | [`test/multi-host-assignment.test.ts`](../../test/multi-host-assignment.test.ts)의 `the coordinator can pin a different catalog route on the remote host and replay it once`, `remote assignments keep their location on replay and won't repeat an accepted attributed prompt` |
| R2 | 제외한 실행기, 카탈로그 밖의 실행기·모델·강도, 필수 훅 누락, 작업 모드 누락·불일치를 생성 전에 거절. | [`test/dispatch.test.ts`](../../test/dispatch.test.ts)의 `명시한 경로의 실행기·모델·강도와 제외 목록을 확인한다`, `명시한 경로에 필수 훅과 작업 권한 모드가 있어야 한다` |
| R3 | 같은 키로 원격 세션·첫 지시 중복 방지. 로컬·원격에서 출처만 바꾼 재시도 거절. 출처 필드 추가 전의 생성 요청과 호환. | [`test/multi-host-assignment.test.ts`](../../test/multi-host-assignment.test.ts)의 `the coordinator can pin a different catalog route on the remote host and replay it once`, [`test/dispatch.test.ts`](../../test/dispatch.test.ts)의 `로컬 배정은 같은 요청 키에서 경로 출처만 바꿔도 거절한다`, `권한과 경로 출처를 기록하기 전에 생성한 작업은 최초 페이로드 그대로 재확인한다` |

## 5. 버린 설계

코디네이터가 고른 경로에도 보드의 등급별 후보 순위나 사용량 정렬을 적용하면 두 배정 정책이 다시 충돌한다. 보드는 대상에서 실행할 수 있는지를 확인한다.
