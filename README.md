# piton

> 원하는 사이트에 JavaScript를 자동으로 주입하는 Chrome 확장 프로그램

Claude AI와 바이브코딩(Vibe Coding)으로 함께 만들었습니다. 💬

---

## 주요 기능

- **사이트별 스크립트 관리** — URL 패턴을 지정해 특정 사이트에만 스크립트를 적용
- **즉시 주입** — 저장과 동시에 현재 열려 있는 매칭 탭에 바로 적용
- **대시보드** — 전체 스크립트를 사이트별로 분류해서 한눈에 확인
- **에디터** — 문법 하이라이팅, 자동 닫기 괄호, 줄 번호 등 내장
- **Import / Export** — 스크립트 백업 및 공유

---

## 설치 방법

1. 이 저장소를 클론하거나 ZIP으로 다운로드
   ```
   git clone https://github.com/seokho7/piton.git
   ```
   또는 GitHub 페이지에서 **Code → Download ZIP** 후 압축 해제
2. Chrome 브라우저에서 `chrome://extensions/` 접속
3. 우상단 **개발자 모드** 토글 ON
4. **압축해제된 확장 프로그램을 로드합니다** 클릭
5. 다운로드한 `piton` 폴더 선택
6. 확장 프로그램 목록에 **piton** 등록 완료

---

## 사용 방법

### 1. 새 스크립트 만들기

1. 브라우저에서 스크립트를 적용할 사이트로 이동
2. 우상단 piton 아이콘 클릭
3. **New** 버튼 클릭 → 에디터 열림
4. `@match` 패턴이 현재 사이트로 자동 입력됨
5. 코드 작성 후 **Save** (또는 `Cmd/Ctrl + S`)
6. 저장 즉시 현재 탭에 적용됨

### 2. 스크립트 헤더 작성법

에디터 상단의 UserScript 헤더로 동작을 설정합니다.

```javascript
// ==UserScript==
// @name         내 스크립트 이름
// @namespace    piton
// @version      1.0
// @description  스크립트 설명
// @author       seokho7
// @match        *://example.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 여기에 코드 작성
  console.log('piton 스크립트 실행!');

})();
```

| 항목 | 설명 |
|------|------|
| `@name` | 스크립트 이름 |
| `@match` | 적용할 URL 패턴 (아래 참고) |
| `@run-at` | 실행 시점 (`document-start` / `document-end` / `document-idle`) |

### 3. URL 패턴 (`@match`) 작성법

| 패턴 | 적용 범위 |
|------|-----------|
| `*://example.com/*` | example.com 전체 (http/https 모두) |
| `https://example.com/*` | example.com https만 |
| `*://*.example.com/*` | example.com 모든 서브도메인 |
| `*://example.com/path/*` | 특정 경로 하위만 |

여러 사이트에 적용하려면 `@match` 줄을 여러 개 추가하면 됩니다.

```javascript
// @match        *://github.com/*
// @match        *://gitlab.com/*
```

### 4. Run 버튼

에디터 상단의 **Run** 버튼을 누르면 저장 여부와 관계없이 현재 작성 중인 코드를 직전에 보던 탭에 즉시 실행합니다. 테스트할 때 유용합니다.

### 5. 팝업 (아이콘 클릭 시)

- 현재 사이트에 등록된 스크립트만 표시됨
- 토글로 개별 스크립트 활성/비활성 전환 가능
- **All Sites** → 대시보드로 이동
- **New** → 새 스크립트 에디터 열기

### 6. 대시보드 (All Sites)

- 전체 스크립트를 사이트별로 분류해서 표시
- 검색, 토글, 편집, 삭제 가능
- 다른 사이트에 등록된 스크립트를 참고하거나 수정할 때 사용

### 7. Import / Export

팝업 하단 버튼으로 스크립트를 JSON 파일로 백업하거나 불러올 수 있습니다.

**Export** — 전체 스크립트를 `piton-YYYY-MM-DD.json`으로 저장  
**Import** — 기존에 내보낸 JSON 파일을 불러와 스크립트 목록에 추가

---

## 개인정보 및 보안

piton은 **어떠한 데이터도 외부로 전송하지 않습니다.**

- 작성한 스크립트는 브라우저 로컬 스토리지(`chrome.storage.local`)에만 저장됩니다
- 서버, 외부 API, 분석 도구와의 통신이 전혀 없습니다
- 네트워크 요청 권한을 요구하지 않으며, 소스코드에서 직접 확인할 수 있습니다

---

## 주의사항

- 스크립트는 **페이지 로드 시점**에 주입됩니다. 저장 직후에는 현재 매칭 탭에 즉시 주입되지만, 이후에는 해당 페이지를 새로고침해야 재실행됩니다.
- 엄격한 CSP(Content Security Policy)를 적용한 사이트에서는 스크립트가 실행되지 않을 수 있습니다.
- 스크립트는 `chrome.storage.local`에 저장됩니다. 확장 프로그램을 삭제하면 데이터도 함께 삭제되므로, 중요한 스크립트는 **Export**로 백업해두세요.

---

## 기술 스택

- Chrome Extension Manifest V3
- Vanilla JavaScript (의존성 없음)
- `chrome.scripting`, `chrome.storage.local`, `chrome.tabs`

---

## 제작

**seokho7** — [github.com/seokho7](https://github.com/seokho7) · [seokhoweb.com](https://seokhoweb.com)

> Claude AI와 바이브코딩으로 제작했습니다.  
> 아이디어를 말하면 Claude가 구현하고, 피드백을 주고받으며 함께 완성한 프로젝트입니다.
