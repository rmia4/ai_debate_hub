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
  user_id       text NOT NULL,
  participant   text NOT NULL CHECK (participant IN ('claude', 'codex')),
  client_id     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_connections_active
  ON oauth_connections (user_id, participant) WHERE revoked_at IS NULL;
