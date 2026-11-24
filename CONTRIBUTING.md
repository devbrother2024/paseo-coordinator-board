# 기여와 릴리스

## 로컬 검증

저장소 루트에서 Node.js 24, Bun 1.4.0, Python 3, unzip을 사용합니다. 다음 명령은 의존성을 잠금 파일에 맞춰 설치하고 타입 검사와 테스트를 실행한 뒤, 현재 버전의 설치 ZIP을 검사합니다.

```sh
npm ci
npm run typecheck
npm test
npm run package:zip
version=$(node -p 'require("./package.json").version')
unzip -tq "dist/coordinator-board-$version.zip"
```

PR을 열거나 새 커밋을 추가하면 **Verify and package**가 같은 검사를 수행합니다. PR 검증은 저장소 읽기 권한으로 실행되며 저장소 시크릿을 사용하지 않습니다. 결과는 PR의 **Checks**에서 확인할 수 있습니다.

## 브랜치

- `next`: 기능 PR이 모이는 개발 브랜치입니다. 모든 PR은 `next`를 대상으로 엽니다. 병합된 변경은 유지관리자의 호스트에서 먼저 사용해 검증합니다.
- `main`: 공개 배포 버전만 담습니다. 레지스트리, Git(`--ref main`), ZIP 설치가 모두 이 브랜치와 태그를 따릅니다. 릴리스 PR(`next` → `main`)로만 바뀝니다.
- 공개 버전의 긴급 수정은 `main`에서 갈라진 브랜치로 `main`에 PR을 열고 패치 릴리스를 낸 뒤, 같은 변경을 `next`에도 반영합니다.

## 유지관리자를 위한 릴리스

1. `next`에서 `package.json`과 `package-lock.json`의 패키지 버전을 올리는 PR을 병합한 뒤, 릴리스 PR(`next` → `main`)을 merge commit으로 병합합니다. 기능 PR에서는 버전을 올리지 않습니다. 예를 들어 `0.4.0`의 Git 태그는 `v0.4.0`, 배포 파일은 `coordinator-board-0.4.0.zip`입니다.
2. `main`의 릴리스 병합 커밋에 버전 태그를 만들어 원격에 푸시합니다. GitHub의 **Releases → Draft a new release**에서 해당 태그를 고르고 변경 사항을 적어 초안을 저장합니다.
3. **Actions → Verify and package → Run workflow**를 열고 기본 브랜치를 선택한 뒤, 초안의 태그를 정확히 입력합니다. 워크플로가 태그의 소스를 검사해 ZIP을 만들고 SHA-256을 대조한 후 기존 릴리스 초안에 첨부합니다.
4. 초안의 **Assets**에서 ZIP을 확인하고 **Publish release**를 누릅니다. 게시 이벤트에서도 같은 검증이 실행됩니다. 이미 같은 이름과 내용의 ZIP이 있으면 그 파일을 유지하고 성공합니다.

파일 변경을 허용하는 릴리스에서는 먼저 게시해도 게시 이벤트가 ZIP을 첨부합니다. 불변 릴리스를 사용하는 저장소에서는 게시 전에 초안에 ZIP을 첨부합니다. [GitHub 릴리스 이벤트](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release) · [불변 릴리스 만들기](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

## 실패 후 다시 실행

태그와 패키지 버전이 다르거나 검증이 실패하면 업로드 단계는 실행되지 않습니다. 릴리스가 없거나 빌드 뒤 태그가 이동해도 첨부를 중단합니다. 일시적인 연결 실패는 같은 버전의 **Re-run failed jobs**로 재시도할 수 있습니다. 검증 산출물의 보존 기간이 지났다면 **Re-run all jobs**로 ZIP을 다시 만듭니다.

같은 이름의 기존 ZIP과 내용이 다르면 작업은 실패하고 기존 첨부를 그대로 둡니다. 릴리스의 태그와 첨부 출처를 확인하세요. 배포 내용을 수정하는 경우에는 새 버전과 태그를 사용합니다. [GitHub CLI 릴리스 첨부 안내](https://cli.github.com/manual/gh_release_upload)
