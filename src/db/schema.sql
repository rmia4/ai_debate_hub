-- 회원
CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,
  email           text,
  display_name    text NOT NULL,
  role            text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  terms_agreed_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 소셜 계정 연결. 이메일로 계정을 합치지 않고 (provider, provider_account_id)로만 찾는다
CREATE TABLE IF NOT EXISTS accounts (
  provider            text NOT NULL CHECK (provider IN ('github', 'google')),
  provider_account_id text NOT NULL,
  user_id             text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS accounts_user_id ON accounts (user_id);

-- 웹 로그인 세션. 쿠키에는 세션 토큰을, DB에는 그 SHA-256 해시를 둔다
CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);

-- 횟수 제한. (key, window_start)별 원자적 UPSERT로 센다
CREATE TABLE IF NOT EXISTS rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- oidc-provider 모델 저장소 (인가 요청·코드·토큰·grant·DCR 클라이언트 등)
CREATE TABLE IF NOT EXISTS oidc_models (
  model       text NOT NULL,
  id          text NOT NULL,
  payload     jsonb NOT NULL,
  grant_id    text,
  user_code   text,
  uid         text,
  expires_at  timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (model, id)
);
CREATE INDEX IF NOT EXISTS oidc_models_grant_id ON oidc_models (grant_id);
CREATE INDEX IF NOT EXISTS oidc_models_uid ON oidc_models (uid);
CREATE INDEX IF NOT EXISTS oidc_models_expires_at ON oidc_models (expires_at);

-- 동의 1회 = 연결 1개. oidc-provider의 grant와 1:1. 토론 자리(A/B)는 연결이 아니라 도구 입력으로 정한다
CREATE TABLE IF NOT EXISTS oauth_connections (
  id            bigserial PRIMARY KEY,
  grant_id      text NOT NULL UNIQUE,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id     text NOT NULL,
  client_name   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoke_reason text
);
-- 이전 구조(연결마다 Claude/Codex 역할)에서 옮긴다. 역할 컬럼을 지우면 그 유니크 인덱스도 함께 지워진다
ALTER TABLE oauth_connections DROP COLUMN IF EXISTS participant;
CREATE INDEX IF NOT EXISTS oauth_connections_user_id ON oauth_connections (user_id, client_id) WHERE revoked_at IS NULL;

-- 토론방. 모든 조회·수정은 owner_id 조건과 함께 src/db/discussions.ts를 거친다
CREATE TABLE IF NOT EXISTS discussions (
  id                 text PRIMARY KEY CHECK (length(id) >= 12),
  owner_id           text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  topic              text NOT NULL,
  context            text NOT NULL DEFAULT '',
  mode               text NOT NULL CHECK (mode IN ('parallel', 'sequential')),
  starter            text CHECK (starter IN ('A', 'B')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'agreed', 'max_reached', 'closed')),
  current_round      int NOT NULL DEFAULT 1,
  max_rounds         int NOT NULL,
  min_rounds         int,
  agreed_proposal_id bigint,
  ended_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discussions_owner_id ON discussions (owner_id, status);

-- 이전 구조의 참여자 값(claude/codex)을 자리(A/B)로 옮긴다. 여러 번 실행해도 결과가 같다
ALTER TABLE discussions DROP CONSTRAINT IF EXISTS discussions_starter_check;
UPDATE discussions SET starter = CASE starter WHEN 'claude' THEN 'A' WHEN 'codex' THEN 'B' ELSE starter END
  WHERE starter IN ('claude', 'codex');
ALTER TABLE discussions ADD CONSTRAINT discussions_starter_check CHECK (starter IN ('A', 'B'));

-- 답변. 동시 방식은 라운드, 순차 방식은 턴 번호를 round에 둔다
CREATE TABLE IF NOT EXISTS turns (
  id                   bigserial PRIMARY KEY,
  discussion_id        text NOT NULL REFERENCES discussions (id) ON DELETE CASCADE,
  round                int NOT NULL,
  participant          text NOT NULL CHECK (participant IN ('A', 'B')),
  client_name          text,
  content              text NOT NULL,
  proposal             text,
  agreement            text CHECK (agreement IN ('agree', 'partial', 'disagree')),
  accepted_proposal_id bigint REFERENCES turns (id),
  sign                 boolean,
  open_issues          jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (discussion_id, round, participant)
);
-- client_name: 제출한 연결의 앱 이름(기록 표시용). 이전 구조에서 옮길 때 컬럼을 더하고 참여자 값을 자리로 바꾼다
ALTER TABLE turns ADD COLUMN IF NOT EXISTS client_name text;
ALTER TABLE turns DROP CONSTRAINT IF EXISTS turns_participant_check;
UPDATE turns SET client_name = COALESCE(client_name, CASE participant WHEN 'claude' THEN 'Claude' ELSE 'Codex' END),
  participant = CASE participant WHEN 'claude' THEN 'A' ELSE 'B' END
  WHERE participant IN ('claude', 'codex');
ALTER TABLE turns ADD CONSTRAINT turns_participant_check CHECK (participant IN ('A', 'B'));

-- 하루 1회 정리 작업의 실행 결과. 운영자 화면에 표시한다
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id       bigserial PRIMARY KEY,
  ran_at   timestamptz NOT NULL DEFAULT now(),
  deleted  jsonb NOT NULL DEFAULT '{}',
  error    text
);
