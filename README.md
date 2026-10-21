# AI Debate Hub

누구나 회원가입 후 자신의 Claude와 Codex를 공용 MCP 서버에 연결해, 하나의 아이디어를 두 AI가 토론·상호 검토하게 하고 합의 결과를 웹에서 확인하는 반자동 서비스입니다.

> **상태:** 4단계(웹 1단계)까지 로컬 자동 테스트로 검증했고, 실제 배포·연결 시험이 남았습니다. 진행 기록은 [1단계 기록](docs/stage1-spike.md), [2단계 기록](docs/stage2-auth.md), [4단계 기록](docs/stage4-web.md)에 있습니다.

## 왜 만드나

- 두 AI 사이에서 답변을 복사·붙여넣기하는 수고를 없앱니다.
- 두 AI의 의견이 언제 일치했는지 서버가 판정해 분명하게 알려 줍니다.
- 라운드별 토론 기록을 웹에서 열람·내보내기할 수 있습니다.

AI 사용료는 각 사용자의 Claude·Codex 구독에서 나가므로, 서버는 호스팅·DB 비용만 부담합니다.

## 동작 방식

사용자는 채팅에 "다음 라운드 진행"만 입력합니다. 서버는 기록 저장, 차례 관리, 합의 판정, 결과 조회만 맡습니다.

```mermaid
flowchart LR
    C[사용자의 Claude] -- OAuth 토큰 --> MCP["/mcp<br/>MCP 엔드포인트"]
    X[사용자의 Codex] -- OAuth 토큰 --> MCP
    B[사용자 브라우저] -- 로그인 세션 --> APP["/app<br/>웹 화면"]
    MCP --> DB[(PostgreSQL)]
    APP --> DB
```

1. 소셜 로그인(GitHub·Google)으로 가입합니다.
2. 쓸 AI(Claude, Codex 등)에 서비스 주소 `https://<서비스 주소>/mcp`를 등록합니다. 토론할 두 채팅은 서로 다른 AI여도 되고, 같은 AI의 두 채팅이어도 됩니다.
3. 웹에서 토론방을 만들고, 양쪽 채팅에 "토론 {ID}에 A석(B석)으로 참여해"를 입력합니다. 규칙은 AI가 서버에서 받아 갑니다.
4. 각 채팅에 "다음 라운드 진행"을 입력하며 토론을 진행합니다.
5. 합의되거나 최대 라운드에 도달하면 종료되고, 결과는 웹에서 확인합니다.

진행 방식은 두 가지입니다.

| 방식 | 진행 | 합의 조건 | 적합한 경우 |
| --- | --- | --- | --- |
| 동시 (`parallel`) | 매 라운드 양쪽이 한 번씩 답변 | 같은 라운드에서 양쪽이 **같은 합의안 ID**에 `agree`, 남은 이견 없음 | 첫 의견을 서로 보지 않고 독립적으로 내야 할 때 |
| 순차 (`sequential`) | 한 턴씩 번갈아 답변 | **상대 사인 → 제안자 사인**처럼 사인이 연속 두 번 | 대화처럼 빠르게 결론을 좁힐 때 |

## 기술 스택

Node.js + TypeScript, Express, `@modelcontextprotocol/sdk`(Streamable HTTP, 무상태), PostgreSQL, zod, 서버 렌더링 HTML. 배포는 Vercel Hobby + Neon Free를 권장합니다. 선택 이유는 [아키텍처](docs/architecture.md)와 [배포](docs/deployment.md)에 있습니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [아키텍처](docs/architecture.md) | 시스템 구성, 기술 스택, 회원 구조와 데이터 격리, 사용량 한도, 데이터 모델 |
| [토론 진행과 MCP 도구](docs/discussion-flow.md) | 동시·순차 방식 흐름, 도구 4개 명세, 제출 규칙, 합의 판정 규칙 |
| [인증·보안](docs/auth-security.md) | 소셜 로그인, MCP OAuth 2.1 인가 서버 설계, 보안 정책 |
| [웹 화면](docs/web-pages.md) | 페이지 목록과 경로, 표시 규칙 |
| [클라이언트 연결과 지시문](docs/client-setup.md) | Claude·Codex 등록 방법, AI용 초기 지시문 |
| [배포](docs/deployment.md) | Render와 Vercel 비교, 권장 구성 |
| [로드맵과 위험 요소](docs/roadmap.md) | 개발 단계별 완료 조건, 위험과 대응, 확인 필요 사항 |
| [1단계 기록](docs/stage1-spike.md) | 인가 라이브러리 선정 결과, 로컬 검증, 배포·연결 시험 절차 |
| [2단계 기록](docs/stage2-auth.md) | 소셜 로그인 라이브러리 선정, 회원·세션·연결 관리 구현, 완료 조건 테스트 |

## 브랜치 규칙

작업은 `feat/*` → `dev` → `main` 순서로 병합합니다. `main`에 병합되면 Vercel에 배포됩니다.

| 브랜치 | 용도 | 병합 대상 |
| --- | --- | --- |
| `feat/<작업명>` | 기능·문서 등 개별 작업. `dev`에서 만듭니다 | `dev` |
| `dev` | 통합·검증 | `main` |
| `main` | 배포 (Vercel) | — |

- `main`과 `dev`에 직접 커밋하지 않고 PR로 병합합니다.
- `main`에는 `dev`만 병합합니다.

## 범위 밖 (비목표)

- 서버가 AI의 턴을 자동으로 시작하는 진행 관리자, MCP sampling
- 3개 이상 AI의 다자 토론
- 유료화
- 사용자 간 토론방 공동 편집
