-- Rollback-only Depot DB acceptance. Run: psql -v ON_ERROR_STOP=1 -f scripts/qa/depot-database.acceptance.sql
BEGIN;
SET LOCAL ROLE service_role;
\set u1 '''00000000-0000-4000-8000-0000000000b1'''
\set u2 '''00000000-0000-4000-8000-0000000000b2'''
\set ag '''00000000-0000-4000-8000-0000000000a1'''
INSERT INTO public.depot_agents(id,user_id,name) VALUES (:ag::uuid, :u1::uuid, 'QA');
INSERT INTO public.depot_nonces(nonce,user_id,agent_id,wallet,purpose,domain,expires_at)
VALUES (repeat('a',64), :u1::uuid, :ag::uuid, '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','studioloco.cfd', now()+interval '5 min'),
       (repeat('b',64), :u1::uuid, :ag::uuid, '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','studioloco.cfd', now()-interval '1 s');

DO $$ DECLARE ok boolean; BEGIN
  -- private agent cannot be published without a verified wallet (constraint)
  BEGIN UPDATE public.depot_agents SET visibility='public' WHERE id='00000000-0000-4000-8000-0000000000a1'; RAISE EXCEPTION 'FAIL publish unverified';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- wrong wallet / wrong user / wrong domain
  ASSERT NOT public.depot_consume_nonce(repeat('a',64),'00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','So11111111111111111111111111111111111111112','controller','studioloco.cfd'), 'wrong wallet';
  ASSERT NOT public.depot_consume_nonce(repeat('a',64),'00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000a1','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','studioloco.cfd'), 'wrong user';
  ASSERT NOT public.depot_consume_nonce(repeat('a',64),'00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','evil.io'), 'wrong domain';
  -- expired
  ASSERT NOT public.depot_consume_nonce(repeat('b',64),'00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','studioloco.cfd'), 'expired';
  -- valid once, then replay refused
  ASSERT public.depot_consume_nonce(repeat('a',64),'00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','studioloco.cfd'), 'valid';
  ASSERT NOT public.depot_consume_nonce(repeat('a',64),'00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin','controller','studioloco.cfd'), 'replay';
  ASSERT (SELECT wallet_verified_at IS NOT NULL AND revision = 2 FROM public.depot_agents WHERE id='00000000-0000-4000-8000-0000000000a1'), 'verified';
  -- still private: no public passport
  ASSERT public.depot_public_passport('00000000-0000-4000-8000-0000000000a1') IS NULL, 'private hidden';
  UPDATE public.depot_agents SET visibility='public', published_at=now() WHERE id='00000000-0000-4000-8000-0000000000a1';
  ASSERT public.depot_public_passport('00000000-0000-4000-8000-0000000000a1') ? 'wallet', 'public visible';
  ASSERT NOT (public.depot_public_passport('00000000-0000-4000-8000-0000000000a1') ? 'user_id'), 'no user id';
END $$;

-- anon / other users: no direct table reads, no consume
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM 1 FROM public.depot_agents; RAISE EXCEPTION 'FAIL anon select'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.depot_reports; RAISE EXCEPTION 'FAIL anon reports'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.depot_consume_nonce('x',null,null,'','',''); RAISE EXCEPTION 'FAIL anon consume'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', true);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.depot_agents) = 0, 'other user sees agent';
  BEGIN UPDATE public.depot_agents SET name='x'; RAISE EXCEPTION 'FAIL auth update'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.depot_nonces; RAISE EXCEPTION 'FAIL nonce read'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT 'DEPOT DB ACCEPTANCE PASSED';
ROLLBACK;
