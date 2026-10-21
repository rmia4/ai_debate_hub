# 4단계 기록: 웹 1단계

[로드맵](roadmap.md#4-웹-1단계-예상-15일) 4단계의 구현 위치와 배포 시 추가 설정입니다. 완료 조건과 한도 검증은 [`test/stage4-criteria.test.ts`](../test/stage4-criteria.test.ts)에 고정했습니다.

## 구현 위치

| 항목 | 위치 |
| --- | --- |
| 소개, 연결 설정 | [`pages.ts`](../src/web/pages.ts) |
| 토론 목록·생성·상세, 강제 종료, 종료 토론 삭제, 마크다운 내보내기, 계정(사용량·내보내기·탈퇴) | [`discussion-pages.ts`](../src/web/discussion-pages.ts) |
| 운영자 화면 (`admin`만, 그 외는 404) | [`admin.ts`](../src/web/admin.ts) |
| 마크다운 렌더링(`marked` → `sanitize-html`, http·https·mailto 링크만 허용, 이미지 제외)과 내보내기 | [`markdown.ts`](../src/web/markdown.ts) |
| 참여자별 지시문([client-setup.md](client-setup.md#ai용-초기-지시문) 문구). 웹 생성과 `start_discussion`이 같이 씀 | [`instructions.ts`](../src/instructions.ts) |
| 생성·종료·삭제·사용량. 웹과 MCP가 같은 `discussionsFor(...).create` 한도 검사를 씀 | [`discussions.ts`](../src/db/discussions.ts) |
| 정리 작업과 실행 기록(`cleanup_runs`) | [`cleanup.ts`](../src/db/cleanup.ts), `GET /cron/cleanup` |
| 보안 헤더(CSP 등), 복사 버튼 스크립트(`/static/app.js`) | [`create-app.ts`](../src/create-app.ts), [`html.ts`](../src/web/html.ts) |

- CSP는 `script-src 'self'`로 인라인 스크립트를 막습니다. 동의 제출 뒤 클라이언트 콜백으로 가는 리디렉트를 막지 않도록 `form-action`은 두지 않았습니다.
- 생성 직후 상세 화면(`/app/d/:id?created=1`)에 지시문과 복사 버튼을 보여 줍니다. 진행 중인 토론의 상세 화면에서는 언제든 다시 볼 수 있습니다.
- 탈퇴는 계정 화면에서 전체 기록을 내려받은 뒤 확인란을 선택해 실행합니다. 계정·연결·토론과 oidc-provider의 grant·토큰·로그인 세션을 한 트랜잭션으로 지웁니다.

## 배포 시 추가 설정

1. **마이그레이션:** `npm run db:migrate`로 `cleanup_runs` 테이블을 만듭니다.
2. **환경변수 `CRON_SECRET`:** 16자 이상 무작위 값. Vercel Cron이 `Authorization: Bearer <값>`으로 보내며, 값이 없으면 `/cron/cleanup`은 항상 401입니다.
3. **Cron:** [`vercel.json`](../vercel.json)에 매일 18:00 UTC(한국 03:00) 1회로 설정했습니다. Hobby 플랜은 하루 1회까지 허용하며 실행 시각은 그 시간대 안에서 달라질 수 있습니다.
4. **운영자 지정:** DB에서 직접 부여합니다. `UPDATE users SET role = 'admin' WHERE email = '<운영자 이메일>';`

## 테스트의 한계

PGlite는 연결이 하나라 트랜잭션이 차례로 실행됩니다. 웹·MCP 동시 생성 테스트는 실제 병렬 HTTP 요청으로 한도 유지를 확인하지만, `users` 행 잠금(`FOR UPDATE`)을 빼도 통과합니다. 잠금 자체의 효과는 여러 연결을 쓰는 실제 PostgreSQL에서만 검증됩니다.
