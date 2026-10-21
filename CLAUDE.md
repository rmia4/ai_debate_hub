# 프로젝트 지침

## 테스트는 작업 영향 범위만
- 변경이 닿는 테스트 파일만 지정해 실행합니다. 예: `npx vitest run --dir test stage4-criteria`
  - `--dir test`를 꼭 붙입니다. 없으면 파일 이름이 부분 일치로 `.claude/worktrees/` 안의 같은 이름 테스트까지 함께 돕니다.
- CSS·문구처럼 화면만 바꾸는 작업이면 그 화면을 검사하는 테스트만 돌립니다. 그런 테스트가 없으면 돌리지 않습니다.
- 전체 테스트(`npm test`)는 사용자가 요청할 때나, DB 스키마·공통 모듈(`src/db/db.ts`, `src/web/html.ts`, `src/config.ts` 등)처럼 여러 곳에 영향을 주는 변경일 때만 실행합니다.
- 루트에서 `npm test`를 돌리면 `.claude/worktrees/`의 테스트까지 함께 실행되므로 더욱 피합니다.
