# 1단계: 라이브러리 선정·원격 연결 시험

[로드맵 1단계](roadmap.md#1-라이브러리-선정원격-연결-시험-예상-15일)의 진행 기록입니다. 로컬 검증은 끝났고, Vercel 배포와 실제 Claude·Codex 연결 시험이 남았습니다.

## 라이브러리 선정: `oidc-provider` 9.12.2

2026-10-20 기준 후보 세 가지의 배포 패키지 코드를 직접 확인했습니다.

| 요구 사항 | `oidc-provider` 9.12.2 | `@better-auth/oauth-provider` 1.7.11 | MCP SDK 1.32.1 내장 인가 서버 |
| --- | --- | --- | --- |
| CIMD | 지원 (draft-02, 실험 기능 `ack` 필요) | 없음 | 없음 (클라이언트 쪽만 있음) |
| CIMD SSRF 방어 | 접속 시점에 특수 용도 IP 차단(DNS 재해석 대응), 리디렉션 따르지 않음, 2.5초 제한, 응답 크기 검사 | — | — |
| DCR | 지원 | 지원 | 지원 |
| PKCE S256, `iss` 응답 | 지원 | 지원 | 지원 |
| `resource` 검증 | `resourceIndicators.getResourceServerInfo`에서 직접 검증 | 지원 | 직접 구현 |
| 리프레시 토큰 재사용 시 연결 폐기 | 재사용 감지 시 grant 전체 폐기, 유예 없음 | 기본 유예 0, 설정 가능 | 직접 구현 |
| 저장소 | 어댑터 직접 작성 (PostgreSQL 테이블 1개) | 라이브러리 스키마 | 직접 구현 |

**결정:** 인가 서버는 `oidc-provider`를 씁니다. 웹 소셜 로그인(GitHub·Google)은 인가 서버와 별개이므로 2단계에서 따로 고릅니다. `oidc-provider`의 동의 화면(interaction)은 직접 만들며, 그 로그인 단계에 웹 세션을 연결합니다.

## 구현 대응

| 문서 설계 | 구현 |
| --- | --- |
| 연결(grant) | `oidc-provider`의 Grant 1개 = `oauth_connections` 행 1개 (`grant_id` 유니크) |
| 사용자·역할당 미폐기 연결 1개 | 동의 승인 시 사용자 단위 advisory 잠금 아래 기존 연결 폐기(만료 포함)·토큰 삭제·새 연결 생성을 한 트랜잭션으로 처리. `(user_id, participant) WHERE revoked_at IS NULL` 부분 유니크 인덱스 |
| 인가 요청 보존 | `oidc-provider`의 Interaction 모델이 DB에 저장(10분). 동의 제출은 interaction uid로만 연결 |
| 인가 코드 1회 교환 | 어댑터 `consume`을 `consumed_at IS NULL` 조건부 UPDATE로 구현. 진 쪽은 오류 |
| 리프레시 30일 고정 | `ttl.RefreshToken`을 첫 발급 시각(`iiat`) 기준 30일로 계산 |
| 폐기 즉시성 | 액세스 토큰은 불투명 토큰. `/mcp`는 매 요청 토큰과 연결의 폐기·만료를 DB에서 확인 |
| 판별 함수 한 곳 | [`resolveCaller`](../src/mcp/caller.ts) |
| 루프백 콜백 경고 | 리디렉트 주소가 모두 루프백이면 동의 화면에 경고 표시 |

1단계 로그인은 시험용입니다(사용자 이름 + `STAGE1_PASSCODE`). 2단계에서 소셜 로그인으로 바꿉니다.

## 로컬 검증 결과

`npm test` (Vitest + PGlite 내장 PostgreSQL), 10개 통과:

- 토큰 없는 `/mcp` 요청의 401과 `WWW-Authenticate`의 `resource_metadata`
- 보호 리소스 메타데이터, RFC 8414 경로의 인가 서버 메타데이터(`client_id_metadata_document_supported` 포함)
- DCR 등록 → 로그인 → 동의(역할 선택) → 코드 교환 → `get_state`가 선택한 역할을 반환
- 루프백 콜백 클라이언트에만 경고 표시, 같은 역할 재연결 시 "교체합니다" 표시
- 다른 계정은 다른 사용자로 판별
- MCP SDK 클라이언트로 `initialize`·`tools/list`·`tools/call`
- 인가 코드 동시 교환 시 한 번만 성공
- 같은 역할 재연결 후 기존 액세스 토큰 즉시 거부, 미폐기 연결 1개
- 리프레시 토큰 재사용 시 연결 전체 폐기
- 다른 `resource` 요청은 `invalid_target`
- 비공개 주소의 CIMD는 조회하지 않고 `invalid_client`

## 남은 작업: 배포와 실제 클라이언트 시험

1. **DB:** Neon 프로젝트를 만들고 스키마를 적용합니다.

   ```bash
   DATABASE_URL="<Neon 직접 연결 주소>" npm run db:migrate
   ```

2. **키:** `npm run gen-keys` 출력값을 `JWKS`로 씁니다.
3. **Vercel:** 저장소를 가져오고 환경변수 `BASE_URL`(고정 도메인, 끝에 `/` 없음), `DATABASE_URL`, `STAGE1_PASSCODE`, `COOKIE_KEYS`, `JWKS`를 설정합니다. Claude는 Anthropic 클라우드에서 접속하므로 배포 보호(Vercel Authentication)가 걸린 미리보기 주소는 쓸 수 없습니다.
4. **Claude:** 커스텀 커넥터에 `<BASE_URL>/mcp`를 등록하고, 로그인·동의에서 "Claude용"을 고른 뒤 채팅에서 `get_state`를 호출합니다.
5. **Codex:** `~/.codex/config.toml`에 등록하고 `codex mcp login ai-debate` 후 "Codex용"을 고르고 `get_state`를 호출합니다.
6. **등록 방식 확인:** 아래 쿼리로 두 클라이언트가 CIMD(`client_id`가 `https://`로 시작)와 DCR 중 무엇을 썼는지 기록합니다.

   ```sql
   SELECT participant, client_id, created_at FROM oauth_connections ORDER BY created_at;
   ```

## 2단계로 넘길 확인 사항

- 웹(`web`) 유형 DCR 클라이언트는 루프백이 아닌 `http://` 리디렉트도 등록됩니다. HTTPS 또는 루프백만 허용하도록 등록 정책을 추가해야 합니다.
- 리프레시 토큰 동시 갱신에서 진 쪽은 `invalid_grant`가 아니라 서버 오류로 끝납니다. "정상적인 동시 갱신·응답 유실 재시도" 기준에 맞게 처리 방식을 정해야 합니다.
- 동의 화면 CSRF 토큰(현재는 interaction 쿠키의 SameSite=Lax에만 의존), 오류 화면(`renderError`) 한국어화.
- Neon 풀링 주소에서 트랜잭션·advisory 잠금 동작 확인.
