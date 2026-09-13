-- Run as the owner of database ananya_mis_dashboard.
-- This database contains MIS authorization and sessions only; no Sathi password.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mis_users (
    id          BIGSERIAL PRIMARY KEY,
    username    VARCHAR(150) NOT NULL,
    full_name   VARCHAR(300) NOT NULL,
    role        VARCHAR(30) NOT NULL DEFAULT 'officer'
                CHECK (role IN ('admin','manager','officer','branch_user')),
    can_export  BOOLEAN NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login  TIMESTAMPTZ
);

-- Idempotent migration for installations created before CSV export permissions.
ALTER TABLE public.mis_users
    ADD COLUMN IF NOT EXISTS can_export BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mis_users_username_lower
    ON public.mis_users (lower(username));

CREATE TABLE IF NOT EXISTS public.mis_user_reports (
    user_id     BIGINT NOT NULL REFERENCES public.mis_users(id) ON DELETE CASCADE,
    report_key  VARCHAR(100) NOT NULL,
    PRIMARY KEY (user_id, report_key)
);

CREATE TABLE IF NOT EXISTS public.mis_sessions (
    token_hash   CHAR(64) PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES public.mis_users(id) ON DELETE CASCADE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ,
    ip_address   VARCHAR(64),
    user_agent   VARCHAR(500)
);

CREATE INDEX IF NOT EXISTS ix_mis_sessions_user_active
    ON public.mis_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.mis_login_audit (
    id          BIGSERIAL PRIMARY KEY,
    username    VARCHAR(150) NOT NULL,
    success     BOOLEAN NOT NULL,
    reason      VARCHAR(100) NOT NULL,
    ip_address  VARCHAR(64),
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_mis_login_audit_time
    ON public.mis_login_audit (attempted_at DESC);

-- Runtime application role needs DML plus access to BIGSERIAL sequences.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.mis_users,
    public.mis_user_reports,
    public.mis_sessions,
    public.mis_login_audit
TO mis_dashboard;

GRANT USAGE, SELECT ON SEQUENCE
    public.mis_users_id_seq,
    public.mis_login_audit_id_seq
TO mis_dashboard;

COMMIT;
