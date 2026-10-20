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

-- 동의 1회 = 연결 1개. oidc-provider의 grant와 1:1
CREATE TABLE IF NOT EXISTS oauth_connections (
  id            bigserial PRIMARY KEY,
  grant_id      text NOT NULL UNIQUE,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  participant   text NOT NULL CHECK (participant IN ('claude', 'codex')),
  client_id     text NOT NULL,
  client_name   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_connections_active
  ON oauth_connections (user_id, participant) WHERE revoked_at IS NULL;
