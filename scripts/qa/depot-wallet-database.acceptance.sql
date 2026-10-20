-- All checks run in one transaction and deliberately roll back every fixture.
DO $$
DECLARE w text := '11111111111111111111111111111111'; other_w text := 'So11111111111111111111111111111111111111112';
  domain text := 'studioloco.cfd'; a jsonb; b jsonb; n integer;
BEGIN
  ASSERT public.depot_auth_challenge(repeat('1',64),w,domain,now(),now()+interval '5 minutes',repeat('f',64)), 'challenge';
  ASSERT public.depot_auth_pending(repeat('1',64),other_w,domain) IS NULL, 'wrong wallet';
  ASSERT public.depot_auth_pending(repeat('1',64),w,'evil.example') IS NULL, 'wrong domain';
  ASSERT public.depot_auth_pending(repeat('1',64),w,domain) IS NOT NULL, 'pending';
  ASSERT public.depot_auth_complete(repeat('1',64),other_w,domain,repeat('a',64)) IS NULL, 'wrong wallet consume';
  a := public.depot_auth_complete(repeat('1',64),w,domain,repeat('a',64));
  ASSERT a->>'wallet'=w AND a->>'id' IS NOT NULL, 'stable principal';
  ASSERT public.depot_auth_complete(repeat('1',64),w,domain,repeat('b',64)) IS NULL, 'replay';
  ASSERT public.depot_auth_pending(repeat('1',64),w,domain) IS NULL, 'consumed challenge';
  ASSERT public.depot_auth_session(repeat('a',64),domain,w)->>'id'=a->>'id', 'valid session';
  ASSERT public.depot_auth_session(repeat('a',64),domain,other_w) IS NULL, 'session wallet scope';
  ASSERT public.depot_auth_session(repeat('a',64),'evil.example',w) IS NULL, 'session domain scope';
  ASSERT NOT public.depot_auth_logout(repeat('a',64),domain,other_w), 'wrong wallet revocation';
  ASSERT public.depot_auth_session(repeat('a',64),domain,w) IS NOT NULL, 'wrong-wallet logout affected session';
  ASSERT public.depot_auth_logout(repeat('a',64),domain,w), 'logout';
  ASSERT public.depot_auth_session(repeat('a',64),domain,w) IS NULL, 'revoked session';
  ASSERT public.depot_auth_challenge(repeat('2',64),w,domain,now(),now()+interval '5 minutes',repeat('f',64)), 'second challenge';
  b := public.depot_auth_complete(repeat('2',64),w,domain,repeat('b',64));
  ASSERT b->>'id'=a->>'id', 'repeat wallet changed principal';
  UPDATE public.depot_wallet_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=repeat('b',64);
  ASSERT public.depot_auth_session(repeat('b',64),domain,w) IS NULL, 'expired session';
  ASSERT NOT public.depot_auth_challenge(repeat('3',64),w,domain,now()+interval '10 minutes',now()+interval '15 minutes',repeat('f',64)), 'future issue';
  ASSERT public.depot_auth_challenge(repeat('4',64),w,domain,now(),now()+interval '5 minutes',repeat('f',64)), 'expiry fixture';
  UPDATE public.depot_login_nonces SET issued_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE nonce=repeat('4',64);
  ASSERT public.depot_auth_pending(repeat('4',64),w,domain) IS NULL, 'expired challenge';
  ASSERT public.depot_auth_complete(repeat('4',64),w,domain,repeat('c',64)) IS NULL, 'expired consume';
  -- Three recent requests + seventeen more reach twenty; the next must be refused atomically.
  FOR n IN 1..17 LOOP
    ASSERT public.depot_auth_challenge(lpad(to_hex(100+n),64,'0'),w,domain,now(),now()+interval '5 minutes',repeat('f',64)), 'quota fixture';
  END LOOP;
  ASSERT NOT public.depot_auth_challenge(repeat('5',64),w,domain,now(),now()+interval '5 minutes',repeat('f',64)), 'request quota';
  ASSERT NOT has_table_privilege('anon','public.depot_wallet_accounts','SELECT'), 'anon principal access';
  ASSERT NOT has_table_privilege('authenticated','public.depot_wallet_sessions','SELECT'), 'session hash exposure';
  ASSERT NOT has_function_privilege('authenticated','public.depot_auth_complete(text,text,text,text)','EXECUTE'), 'public session mint';
  ASSERT NOT has_function_privilege('anon','public.depot_auth_session(text,text,text)','EXECUTE'), 'public session lookup';
  ASSERT has_function_privilege('service_role','public.depot_auth_complete(text,text,text,text)','EXECUTE'), 'service missing';
  RAISE EXCEPTION 'DEPOT WALLET AUTH ACCEPTANCE PASSED (forced rollback)';
END $$;
