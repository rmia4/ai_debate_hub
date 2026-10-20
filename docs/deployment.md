# 배포

권장안은 **Vercel Hobby(서버) + Neon Free(PostgreSQL)** 입니다. 단, Vercel Hobby는 비상업적 개인 용도로만 허용되므로 **광고·유료 기능 없이 무료로 공개**하는 조건에서만 이 구성을 유지합니다. 수익화하거나 사용자가 늘면 Pro 또는 다른 호스팅으로 옮깁니다.

## Render vs Vercel

| 항목 | Render 무료 | Vercel Hobby + Neon Free |
| --- | --- | --- |
| 실행 방식 | 상시 프로세스(Express) | 요청 단위 서버리스 함수 |
| 유휴 시 동작 | 15분 무요청 시 정지, 깨어나는 데 약 1분 | DB는 5분 유휴 후 정지, 다음 쿼리에서 수백 밀리초 안에 재개 |
| DB | 무료 Postgres는 생성 30일 후 만료, 14일 유예 후 삭제 | 프로젝트당 저장 0.5GB, 월 100 CU-시간 |
| 이용 조건 | 무료 인스턴스 시간 한도 내 | Vercel Hobby는 비상업적 개인 용도만 허용 |
| MCP 적합성 | 첫 호출이 클라이언트 타임아웃에 걸릴 수 있음 | 2026-07-28 명세의 무상태 방식과 잘 맞음 |
| 유료 전환 | Starter $7/월로 정지 해제 | Vercel Pro, Neon Launch(사용량 과금) |

## 운영 원칙

- 저장 용량 0.5GB가 다중 사용자 운영의 실질적 한계입니다. [사용량 한도](architecture.md#사용량-한도)와 180일 보존 정책으로 관리하고, 운영자 화면에 DB 사용량을 표시합니다.
- 코드는 Express 앱 하나로 작성하고, Vercel에서는 같은 앱을 함수로 감싸 배포합니다. 필요하면 Render 유료 플랜 등으로 그대로 옮길 수 있습니다.
- OAuth 콜백 주소가 배포 도메인에 묶이므로, 처음부터 고정 도메인(Vercel 기본 도메인 또는 개인 도메인)을 정해 GitHub·Google 앱에 등록합니다.
- 하루 1회 정리 작업은 Vercel Cron으로 실행합니다.

출처: [Render 무료 플랜 문서](https://render.com/docs/free), [Render 요금 해설](https://livemy.app/blog/render-pricing), [Vercel 공정 사용 지침](https://vercel.com/docs/limits/fair-use-guidelines), [Neon 요금제](https://neon.com/pricing), [Neon vs Supabase 무료 플랜](https://neon.com/guides/neon-vs-supabase-free-plan)
