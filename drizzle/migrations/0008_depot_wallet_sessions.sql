-- Wallet principals are independent of email identities. Only the server can read or mutate auth state.
CREATE TABLE public.depot_wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL UNIQUE CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.depot_login_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{64}$'), wallet text NOT NULL,
  domain text NOT NULL, ip_hash text NOT NULL CHECK (ip_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes')
);
CREATE INDEX depot_login_wallet_time ON public.depot_login_nonces(wallet, issued_at);
CREATE INDEX depot_login_ip_time ON public.depot_login_nonces(ip_hash, issued_at);
CREATE TABLE public.depot_wallet_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES public.depot_wallet_accounts(id) ON DELETE CASCADE,
  domain text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '12 hours'), revoked_at timestamptz
);
CREATE INDEX depot_wallet_sessions_account ON public.depot_wallet_sessions(account_id);
ALTER TABLE public.depot_wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depot_login_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.depot_wallet_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.depot_wallet_accounts, public.depot_login_nonces, public.depot_wallet_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.depot_wallet_accounts, public.depot_login_nonces, public.depot_wallet_sessions TO service_role;

CREATE FUNCTION public.depot_auth_challenge(_nonce text, _wallet text, _domain text, _issued_at timestamptz, _expires_at timestamptz, _ip_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  -- One lock makes wallet/IP/global limits atomic across concurrent requests.
  PERFORM pg_advisory_xact_lock(hashtextextended('depot-wallet-login',0));
  IF _issued_at > now() + interval '5 seconds' OR _issued_at < now() - interval '30 seconds'
     OR _expires_at <= now() OR _expires_at > _issued_at + interval '5 minutes'
     OR _wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN RETURN false; END IF;
  DELETE FROM public.depot_login_nonces WHERE expires_at < now() - interval '1 hour';
  DELETE FROM public.depot_wallet_sessions WHERE expires_at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.depot_login_nonces WHERE issued_at > now()-interval '10 minutes' AND (wallet=_wallet OR ip_hash=_ip_hash)) >= 20
     OR (SELECT count(*) FROM public.depot_login_nonces WHERE issued_at > now()-interval '1 hour') >= 1000 THEN RETURN false; END IF;
  INSERT INTO public.depot_login_nonces(nonce,wallet,domain,ip_hash,issued_at,expires_at)
  VALUES(_nonce,_wallet,_domain,_ip_hash,_issued_at,_expires_at);
  RETURN true;
END $$;

CREATE FUNCTION public.depot_auth_pending(_nonce text, _wallet text, _domain text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object('nonce',nonce,'wallet',wallet,'domain',domain,
    'issuedAt',to_char(issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM public.depot_login_nonces WHERE nonce=_nonce AND wallet=_wallet AND domain=_domain
    AND consumed_at IS NULL AND issued_at <= now()+interval '5 seconds' AND expires_at > now()
$$;

-- Signature verification happens in the server before this service-only atomic consume.
CREATE FUNCTION public.depot_auth_complete(_nonce text, _wallet text, _domain text, _token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE uid uuid; expiry timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('depot-wallet:'||_wallet,0));
  UPDATE public.depot_login_nonces SET consumed_at=now()
  WHERE nonce=_nonce AND wallet=_wallet AND domain=_domain AND consumed_at IS NULL
    AND issued_at <= now()+interval '5 seconds' AND expires_at > now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.depot_wallet_accounts(wallet) VALUES (_wallet) ON CONFLICT(wallet) DO NOTHING;
  SELECT id INTO uid FROM public.depot_wallet_accounts WHERE wallet=_wallet;
  -- Bound active sessions; expired or oldest sessions never become permissions again.
  UPDATE public.depot_wallet_sessions SET revoked_at=now() WHERE token_hash IN (
    SELECT token_hash FROM public.depot_wallet_sessions WHERE account_id=uid AND revoked_at IS NULL
      ORDER BY created_at DESC OFFSET 9
  );
  INSERT INTO public.depot_wallet_sessions(token_hash,account_id,domain) VALUES(_token_hash,uid,_domain) RETURNING expires_at INTO expiry;
  RETURN jsonb_build_object('id',uid,'wallet',_wallet,'expiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;

CREATE FUNCTION public.depot_auth_session(_token_hash text, _domain text, _wallet text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object('id',a.id,'wallet',a.wallet,'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM public.depot_wallet_sessions s JOIN public.depot_wallet_accounts a ON a.id=s.account_id
  WHERE s.token_hash=_token_hash AND s.domain=_domain AND a.wallet=_wallet AND s.revoked_at IS NULL
    AND s.created_at <= now() AND s.expires_at > now()
$$;
CREATE FUNCTION public.depot_auth_logout(_token_hash text, _domain text, _wallet text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.depot_wallet_sessions s SET revoked_at=now() FROM public.depot_wallet_accounts a
  WHERE s.account_id=a.id AND s.token_hash=_token_hash AND s.domain=_domain AND a.wallet=_wallet;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.depot_auth_challenge(text,text,text,timestamptz,timestamptz,text), public.depot_auth_pending(text,text,text), public.depot_auth_complete(text,text,text,text), public.depot_auth_session(text,text,text), public.depot_auth_logout(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.depot_auth_challenge(text,text,text,timestamptz,timestamptz,text), public.depot_auth_pending(text,text,text), public.depot_auth_complete(text,text,text,text), public.depot_auth_session(text,text,text), public.depot_auth_logout(text,text,text) TO service_role;
