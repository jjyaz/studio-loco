ALTER TABLE public.depot_agents ADD CONSTRAINT depot_gate_age_60 CHECK (gate_max_age_s <= 60) NOT VALID;
COMMENT ON COLUMN public.depot_agents.launch IS 'Whitelisted verified launch identity; written only by depot_link_launch after server-side receipt reconstruction.';
CREATE UNIQUE INDEX depot_agents_launch_mint ON public.depot_agents ((launch->>'cluster'), (launch->>'mint')) WHERE launch IS NOT NULL;
CREATE UNIQUE INDEX depot_agents_launch_sig ON public.depot_agents ((launch->>'signature')) WHERE launch IS NOT NULL;

CREATE OR REPLACE FUNCTION public.depot_link_launch(_user uuid, _agent uuid, _revision integer, _wallet text, _digest text, _launch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.depot_agents;
BEGIN
  SELECT * INTO a FROM public.depot_agents WHERE id = _agent FOR UPDATE;
  IF NOT FOUND OR a.user_id <> _user THEN RAISE EXCEPTION 'agent not owned'; END IF;
  IF a.wallet IS DISTINCT FROM _wallet OR a.wallet_verified_at IS NULL THEN RAISE EXCEPTION 'agent wallet changed or unverified'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.depot_metadata m WHERE m.digest = _digest AND m.agent_id = _agent AND m.user_id = _user) THEN
    RAISE EXCEPTION 'metadata not owned by this agent';
  END IF;
  IF a.launch IS NOT NULL THEN
    IF a.launch->>'mint' = _launch->>'mint' AND a.launch->>'signature' = _launch->>'signature' THEN
      RETURN jsonb_build_object('status', 'already-linked', 'revision', a.revision);
    END IF;
    RAISE EXCEPTION 'agent already has a different verified launch';
  END IF;
  IF a.revision <> _revision THEN RAISE EXCEPTION 'agent revision changed'; END IF;
  UPDATE public.depot_agents SET launch = _launch, revision = revision + 1, updated_at = now() WHERE id = _agent;
  RETURN jsonb_build_object('status', 'linked', 'revision', a.revision + 1);
END $$;
REVOKE ALL ON FUNCTION public.depot_link_launch(uuid, uuid, integer, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.depot_link_launch(uuid, uuid, integer, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.depot_consume_nonce(_nonce text, _user uuid, _agent uuid, _wallet text, _purpose text, _domain text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n public.depot_nonces;
BEGIN
  IF _purpose = 'controller' AND EXISTS (SELECT 1 FROM public.depot_agents WHERE id = _agent AND launch IS NOT NULL AND wallet IS DISTINCT FROM _wallet) THEN
    RETURN false;
  END IF;
  UPDATE public.depot_nonces SET consumed_at = now()
   WHERE nonce = _nonce AND consumed_at IS NULL AND expires_at > now() AND issued_at <= now()
     AND user_id = _user AND agent_id = _agent AND wallet = _wallet AND purpose = _purpose AND domain = _domain
  RETURNING * INTO n;
  IF NOT FOUND THEN RETURN false; END IF;
  IF _purpose = 'controller' THEN
    UPDATE public.depot_agents SET wallet = _wallet, wallet_verified_at = now(), revision = revision + 1, updated_at = now()
     WHERE id = _agent AND user_id = _user AND (launch IS NULL OR wallet = _wallet);
    IF NOT FOUND THEN RAISE EXCEPTION 'agent not owned or launch-bound to another wallet'; END IF;
  ELSE
    INSERT INTO public.depot_viewer_wallets(user_id, agent_id, wallet, verified_at) VALUES (_user, _agent, _wallet, now())
    ON CONFLICT (user_id, agent_id) DO UPDATE SET wallet = EXCLUDED.wallet, verified_at = now();
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.depot_consume_nonce(text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.depot_consume_nonce(text, uuid, uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.depot_public_passport(_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description, 'mission', a.mission,
    'wallet', a.wallet, 'walletVerifiedAt', a.wallet_verified_at, 'publishedAt', a.published_at, 'revision', a.revision,
    'reportPolicy', a.report_policy, 'gateMint', a.gate_mint, 'gateMinRaw', a.gate_min_raw,
    'launch', CASE WHEN a.launch IS NULL THEN NULL ELSE jsonb_build_object(
      'cluster', a.launch->>'cluster', 'config', a.launch->>'config', 'mint', a.launch->>'mint', 'pool', a.launch->>'pool',
      'signature', a.launch->>'signature', 'slot', (a.launch->>'slot')::bigint, 'presetId', a.launch->>'presetId',
      'presetVersion', (a.launch->>'presetVersion')::int, 'metadataDigest', a.launch->>'metadataDigest', 'verifiedAt', a.launch->>'verifiedAt') END,
    'metadata', COALESCE((SELECT jsonb_agg(jsonb_build_object('digest', m.digest, 'version', m.version, 'publishedAt', m.published_at) ORDER BY m.version)
                 FROM public.depot_metadata m WHERE m.agent_id = a.id), '[]'::jsonb))
  FROM public.depot_agents a WHERE a.id = _id AND a.visibility = 'public' AND a.wallet_verified_at IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.depot_public_passport(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.depot_public_passport(uuid) TO anon, authenticated, service_role;