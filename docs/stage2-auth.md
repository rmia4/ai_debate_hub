# 2단계: 회원·OAuth

[로드맵 2단계](roadmap.md#2-회원oauth-예상-25일-1단계-결과로-재산정)의 진행 기록입니다. 로컬 자동 테스트로 완료 조건을 모두 검증했고, 실제 GitHub·Google 로그인과 Claude·Codex 연결은 배포 시험에서 확인합니다.

## 소셜 로그인 라이브러리 선정: `arctic` 3.7.0

인가 서버(`oidc-provider`)는 1단계에서 정했으므로, 여기서는 웹 로그인용 GitHub·Google OAuth 클라이언트만 고릅니다. 세션은 [인증·보안](auth-security.md#웹-보안) 설계대로 DB에 직접 저장합니다. 2026-10-20 기준 npm 배포본을 확인했습니다.

| 후보 | 버전 (최근 배포) | 장점 | 맞지 않는 점 |
| --- | --- | --- | --- |
| **Arctic** | 3.7.0 (2025-05) | OAuth 클라이언트 기능만 제공(인가 주소 생성, 코드 교환, PKCE). 의존성은 `@oslojs/*` 3개. 세션·스키마를 강제하지 않음 | 프로필 조회·세션은 직접 작성 |
| Better Auth | 1.7.11 | 소셜 로그인·세션·계정 연결을 한 번에 제공 | 자체 `users`·`sessions` 스키마와 Kysely를 가져옴. 인가 서버(`oidc-provider`)와 별개의 인증 체계가 하나 더 생기고, 정지 검사를 넣을 지점이 라이브러리 안쪽에 있음 |
| Passport + `passport-github2`·`passport-google-oauth20` | 0.7.0 / 0.1.12 (2022) / 2.0.0 (2023) | 익숙한 방식 | 전략 패키지가 오래 갱신되지 않음. `express-session` 전제 |
| Auth.js (`@auth/express`) | 0.12.3 | 공급자가 많음 | Express 통합이 0.x 실험 단계. 자체 세션·어댑터 모델 |
| `openid-client` | 6.8.8 | 표준 OIDC 구현 | GitHub는 OIDC가 아니라 따로 처리해야 함 |

**결정:** Arctic을 씁니다. 필요한 것은 "두 공급자의 코드 교환"뿐이고, 세션·사용자 테이블·정지 검사는 설계 문서대로 직접 두는 편이 인가 서버와 한곳에서 맞물리기 쉽습니다. Arctic은 공급자 엔드포인트로 전역 `fetch`를 쓰므로, 테스트에서는 GitHub·Google 주소만 가로채는 가짜 공급자로 실제 Arctic 코드를 그대로 통과시킵니다([`test/helpers.ts`](../test/helpers.ts)).

- GitHub: `read:user user:email` 범위. `/user`의 `id`로 계정을 식별하고, `/user/emails`의 기본·인증된 이메일만 저장합니다. GitHub OAuth 앱은 PKCE를 지원하지 않으므로 `state` 쿠키로 요청 위조를 막습니다.
- Google: `openid email profile` 범위, PKCE(S256). 토큰 엔드포인트에서 TLS로 직접 받은 ID 토큰이므로 서명 검증 대신 `iss`·`aud`를 확인합니다(OIDC Core 3.1.3.7). `sub`로 식별하고, `email_verified`일 때만 이메일을 저장합니다.
- 계정은 `(provider, provider_account_id)`로만 찾습니다. 이메일이 같아도 다른 공급자 계정을 합치지 않습니다(이메일 기반 계정 탈취 방지).

## 구현 대응

| 문서 설계 | 구현 |
| --- | --- |
| `users`·`accounts`·`sessions`·`rate_limits` | [`schema.sql`](../src/db/schema.sql). `users.status`(`active`/`suspended`), `terms_agreed_at` |
| 첫 로그인 시 자동 가입·약관 동의 | 로그인 화면에 "처음 로그인하면 약관·개인정보 처리방침에 동의한 것으로 봅니다"를 고지하고, 가입 시 `terms_agreed_at` 기록. 같은 계정의 동시 첫 로그인은 `accounts` 기본 키로 한 명만 만들어짐 |
| DB 세션, 서명 쿠키 (HttpOnly·Secure·SameSite=Lax, 7일) | [`session.ts`](../src/web/session.ts). 쿠키 `sid` = 무작위 토큰 + HMAC 서명(`COOKIE_KEYS` 맨 앞 키로 서명, 모든 키로 검증). DB에는 토큰의 SHA-256만 저장. 로그인할 때마다 새 세션 발급 |
| CSRF 토큰 (동의 제출, 연결 해제, 로그아웃) | 세션 토큰의 HMAC 값을 숨은 필드로 넣고 비교. 저장소가 필요 없음 |
| 로그인 단계와 웹 세션 연결 | 인가 요청 → 동의 화면에서 웹 세션이 없으면 `/login?return_to=/oauth/interaction/<uid>`로 보냈다가 돌아옴. 동의 제출 한 번으로 `login`·`consent` 결과를 함께 넘김 |
| 로그인 상태의 기준은 웹 세션 하나 | 인가가 끝나면 `oidc-provider` 세션을 지움. 같은 브라우저에서 다른 계정으로 바꿔 로그인해도 이전 계정으로 인가되지 않음. 토큰은 `expiresWithSession: false`로 연결 수명(30일)만 따름 |
| 연결 설정 화면 | [`/app/connections`](../src/web/pages.ts): 서비스 주소, Claude·Codex 등록 안내, 미폐기 연결 목록(역할, 앱 이름, 연결·마지막 사용·만료 시각, 만료 표시), 해제. 해제는 본인 연결만(그 외 404) |
| 약관·개인정보 | `/terms`, `/privacy`. 수집 항목, 보존 기간, 파기, 국외 이전(Vercel·Neon), 연락처(`CONTACT_EMAIL`) |
| 횟수 제한 | `rate_limits`에 `INSERT … ON CONFLICT … DO UPDATE … RETURNING count`. 로그인 시작 IP당 10분 30회, DCR 등록 IP당 1시간 100회 |

### 계정 정지 검사 지점

정지는 연결·세션·토큰을 폐기하지 않고, 아래 지점에서 매번 `users.status`를 확인합니다.

| 경로 | 위치 | 정지 중 동작 |
| --- | --- | --- |
| MCP 호출 | [`resolveCaller`](../src/mcp/caller.ts) → `touchConnectionByGrant`가 `users`와 조인 | 401 |
| 웹 세션 | `/app` 미들웨어, `/login` | 403 정지 안내 + 로그아웃 버튼 |
| 새 로그인 | 소셜 로그인 콜백 | 403, 세션을 만들지 않음 |
| 인가(동의 화면·제출) | [`interaction.ts`](../src/oauth/interaction.ts) | 403 정지 안내 |
| 토큰 발급(코드 교환·리프레시) | `findAccount`가 사용자 상태와 연결의 폐기·만료를 확인 | `invalid_grant`. 리프레시는 토큰 소비 전에 거부되므로 정지 해제 후 같은 리프레시 토큰을 그대로 씀 |

## 1단계에서 넘어온 확인 사항

| 항목 | 처리 |
| --- | --- |
| web 유형 DCR 클라이언트의 `http://` 리디렉트 | `extraClientMetadata` 검증기로 web 유형은 HTTPS 또는 루프백 HTTP만 허용(`invalid_redirect_uri`). CIMD 문서에도 같이 적용됨. native 유형은 라이브러리 규칙(루프백 HTTP, 사설 스킴) 그대로 |
| 리프레시 토큰 동시 갱신에서 진 쪽의 서버 오류 | 아래 유예 정책으로 처리. 어댑터의 `consume` 실패는 서버 오류 대신 `invalid_grant`. 인가 코드 동시 교환에서 진 쪽도 `invalid_grant` |
| 동의 화면 CSRF, `renderError` 한국어화 | 동의·거부 제출에 세션 CSRF 토큰 필수. `renderError`는 오류 코드별 한국어 안내와 오류 코드를 표시 |
| Neon 풀링 주소의 트랜잭션·advisory 잠금 | 배포 시험에서 확인 (남음) |

### 리프레시 토큰 유예 정책 (30초)

[RFC 9700 4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)의 회전 방식에 응답 유실 재시도를 위한 짧은 유예를 더했습니다. 구현은 [`adapter.ts`](../src/oauth/adapter.ts)에 있습니다.

- 갱신마다 새 리프레시 토큰을 발급하고, 쓴 토큰은 `consumed_at`을 남깁니다.
- 연결마다 **아직 쓰지 않은 리프레시 토큰은 1개만** 둡니다. 새 리프레시 토큰을 저장할 때 같은 연결의 미사용 토큰을 지웁니다(연결 단위 advisory 잠금 아래).
- 쓴 토큰이 다시 오면:
  - 30초 안이고 그 뒤에 쓰인 토큰이 없으면(= 직전 토큰): 응답 유실 재시도나 동시 갱신으로 보고 새 토큰을 발급합니다. 받지 못한 쪽 토큰은 위 규칙으로 무효가 됩니다.
  - 그 밖(이미 다음 토큰을 썼거나 30초가 지남): 재사용으로 보고 **연결과 파생 토큰 전체를 폐기**합니다.
- 동시 갱신은 모두 200으로 끝나며, 살아남는 리프레시 토큰은 마지막에 저장된 하나입니다. 클라이언트가 다른 응답의 토큰을 저장했다면 다음 갱신이 `invalid_grant`로 끝나고 재연결이 필요하지만, 연결이 폐기되지는 않습니다. MCP SDK처럼 갱신을 직렬화하는 클라이언트에서는 생기지 않습니다.
- 대가: 리프레시 토큰을 훔친 쪽이 정상 갱신 직후 30초 안에 쓰면 탐지되지 않고 토큰을 받습니다. 이때 정상 클라이언트의 토큰이 무효가 되어 재연결하게 되고, 재연결은 같은 역할의 기존 연결을 폐기하므로 탈취한 쪽 토큰도 끊깁니다.

## 로컬 검증 결과

`npm test` 36개 통과, `npm run typecheck` 통과. 주요 검사를 일부러 빼 보는 변이 시험(정지 검사, 유예, 미사용 토큰 1개 제한, 동의 CSRF, `Secure`, `oidc-provider` 세션 삭제, 만료 연결 폐기)에서 각각 테스트가 실패하는 것도 확인했습니다.

로드맵 완료 조건은 [`test/stage2-criteria.test.ts`](../test/stage2-criteria.test.ts)에 조건별로 고정했습니다.

| 완료 조건 | 테스트 |
| --- | --- |
| 두 계정의 Claude·Codex가 서로 다른 사용자로 판별 | GitHub·Google 두 계정의 연결 4개가 각자 (사용자, 역할)로 판별. 같은 브라우저에서 계정을 바꾸면 새 계정으로 연결 |
| 연결 해제·교체 후 기존 액세스 토큰 즉시 거부 | 같은 역할 재연결(교체), 연결 설정 화면의 해제 모두 즉시 401·`invalid_grant`. 다른 역할 연결은 유지 |
| 리프레시 토큰 재사용 시 연결 전체 폐기 | 다음 토큰으로 넘어간 토큰의 재사용, 유예 시간이 지난 재사용 |
| 정상적인 동시 갱신·응답 유실 재시도 처리 | 같은 토큰 재시도 성공 후 계속 갱신, 3개 동시 갱신 모두 200·미사용 토큰 1개 |
| 인가 코드 동시 교환 시 한 번만 성공 | 3개 동시 교환 중 1개만 200, 나머지 `invalid_grant` |
| 30일 만료 후 재연결 요구 | 리프레시 토큰 만료가 갱신 후에도 연결 만료와 같음, 만료 후 액세스·리프레시 거부, 재연결 성공 |
| 동시 재연결 후 미폐기 연결 1개 | 세 브라우저 동시 동의 후 미폐기 1개, 토큰은 그 연결만 받음 |
| 만료·미폐기 연결이 있어도 재연결 성공 | 만료된 연결은 `replaced`로 폐기되고 새 연결 동작 |
| 정지 계정 차단 / 정지 해제 후 동작 | 기존 웹 세션·MCP·새 로그인·동의 화면·동의 제출·갱신·코드 교환 차단, 로그아웃 허용. 해제 후 웹 세션·액세스·리프레시 토큰 재사용, 정지 중 만료된 세션·폐기된 연결·로그아웃한 세션은 복구 안 됨 |

그 밖에 [`test/web-auth.test.ts`](../test/web-auth.test.ts)(가입·계정 구분, `state` 위조, 열린 리디렉트, 로그인 횟수 제한, 쿠키 속성, 위조·만료 세션, 로그아웃 CSRF, 연결 해제 CSRF·타인 연결, 공개 페이지, 카운터 원자성)와 [`test/oauth-flow.test.ts`](../test/oauth-flow.test.ts)(1단계 항목, DCR 등록 정책, 로그인 경유 동의 화면, 동의 CSRF, 한국어 오류 화면)가 있습니다.

## 배포 시 추가 설정

1. **GitHub OAuth 앱**(Settings → Developer settings → OAuth Apps): Homepage `<BASE_URL>`, Authorization callback URL `<BASE_URL>/auth/github/callback`. 값을 `GITHUB_CLIENT_ID`·`GITHUB_CLIENT_SECRET`에 넣습니다.
2. **Google OAuth 클라이언트**(Google Cloud Console → API 및 서비스 → 사용자 인증 정보, 유형 "웹 애플리케이션"): 승인된 리디렉션 URI `<BASE_URL>/auth/google/callback`. OAuth 동의 화면에 개인정보 처리방침 주소 `<BASE_URL>/privacy`를 넣습니다. 값은 `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`.
3. **환경변수:** `STAGE1_PASSCODE`는 더 쓰지 않습니다. 위 네 값과 `CONTACT_EMAIL`을 추가합니다. GitHub·Google 중 하나만 설정하면 그 버튼만 보입니다.
4. **DB:** 1단계 시험 DB는 사용자 ID 형식(`stage1:<이름>`)이 다르고 `oauth_connections`에 새 열·외래 키가 없으므로 지우고 다시 만듭니다. 1단계 시험 연결은 모두 사라지므로 Claude·Codex에서 다시 연결합니다.

   ```sql
   DROP TABLE IF EXISTS oauth_connections, oidc_models;
   ```

   ```bash
   DATABASE_URL="<Neon 직접 연결 주소>" npm run db:migrate
   ```

5. **운영자 계정과 정지:** 운영자 화면은 4단계입니다. 그 전까지는 DB에서 직접 바꿉니다.

   ```sql
   UPDATE users SET role = 'admin' WHERE email = '<운영자 이메일>';
   UPDATE users SET status = 'suspended' WHERE id = '<사용자 ID>';  -- 해제는 'active'
   ```

## 남은 일과 한계

- **토큰 저장 방식:** `oidc-provider`의 불투명 토큰은 토큰 값이 곧 저장 키이고 내용(`jti`)에도 들어 있어, `oidc_models`에 평문으로 남습니다. [위험 요소](roadmap.md#위험-요소)의 "해시 저장"과 다르므로, 어댑터에서 키와 `jti`를 해시로 바꾸는 작업을 따로 검토합니다.
- **횟수 제한 범위:** 로그인 시작과 DCR 등록에만 적용했습니다. 인가·제출 제한은 해당 기능과 함께 넣습니다(제출은 3단계).
- **정리 작업:** 만료된 세션·`oidc_models`·`rate_limits` 행 삭제는 4단계 하루 1회 작업에서 합니다.
- **약관·개인정보 문구:** 비상업 무료 서비스 기준의 초안입니다. 공개 전에 연락처와 Neon 지역을 실제 값으로 확인합니다.
- **배포 시험:** 실제 GitHub·Google 로그인, Claude·Codex 연결, Neon 풀링 주소에서 advisory 잠금 동작을 확인합니다.
