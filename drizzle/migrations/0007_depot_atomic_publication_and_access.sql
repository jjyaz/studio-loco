-- Service-only atomic boundaries for immutable publication and protected report delivery.
CREATE OR REPLACE FUNCTION public.depot_publish_metadata(
  _user uuid, _agent uuid, _digest text, _body text,
  _image_digest text, _image_mime text, _image_hex text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.depot_agents; m public.depot_metadata; v integer; b bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('depot-metadata:' || _user::text, 0));
  SELECT * INTO a FROM public.depot_agents WHERE id = _agent FOR UPDATE;
  IF NOT FOUND OR a.user_id <> _user OR a.wallet_verified_at IS NULL THEN RAISE EXCEPTION 'verified owned agent required'; END IF;
  b := decode(_image_hex, 'hex');
  IF octet_length(b) < 1 OR octet_length(b) > 262144 OR octet_length(_body) > 4096
     OR encode(sha256(b), 'hex') <> _image_digest
     OR encode(sha256(convert_to(_body, 'UTF8')), 'hex') <> _digest THEN
    RAISE EXCEPTION 'published content integrity or size invalid';
  END IF;
  SELECT * INTO m FROM public.depot_metadata WHERE digest = _digest;
  IF FOUND THEN
    IF m.user_id <> _user OR m.agent_id IS DISTINCT FROM _agent THEN RAISE EXCEPTION 'content belongs to another agent; publish an agent-specific version'; END IF;
    RETURN jsonb_build_object('digest', m.digest, 'version', m.version, 'publishedAt', m.published_at, 'reused', true);
  END IF;
  IF (SELECT count(*) FROM public.depot_metadata WHERE user_id = _user AND published_at > now() - interval '1 hour') >= 20
     OR (SELECT count(*) FROM public.depot_metadata WHERE user_id = _user) >= 100 THEN
    RAISE EXCEPTION 'metadata limit reached: twenty versions per hour and one hundred permanent versions per account';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM public.depot_metadata WHERE agent_id = _agent;
  INSERT INTO public.depot_images(digest, user_id, mime, bytes) VALUES (_image_digest, _user, _image_mime, b)
    ON CONFLICT (digest) DO NOTHING;
  INSERT INTO public.depot_metadata(digest, user_id, agent_id, version, body, image_digest)
    VALUES (_digest, _user, _agent, v, _body, _image_digest) RETURNING * INTO m;
  RETURN jsonb_build_object('digest', m.digest, 'version', m.version, 'publishedAt', m.published_at, 'reused', false);
END $$;
REVOKE ALL ON FUNCTION public.depot_publish_metadata(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.depot_publish_metadata(uuid, uuid, text, text, text, text, text) TO service_role;

-- Balance was measured on chain by the server. Re-check ALL mutable access scope in the
-- same database statement that reads protected contents; changing policy while RPC is in
-- flight cannot deliver reports under the superseded policy. The client cannot call this.
CREATE OR REPLACE FUNCTION public.depot_holder_reports(
  _user uuid, _agent uuid, _revision integer, _wallet text,
  _mint text, _balance text, _read_at timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.depot_agents a JOIN public.depot_viewer_wallets w ON w.agent_id = a.id
    WHERE a.id = _agent AND a.revision = _revision AND a.visibility = 'public'
      AND a.report_policy = 'token-holders' AND a.gate_mint = _mint
      AND w.user_id = _user AND w.wallet = _wallet
      AND w.verified_at <= now() AND w.verified_at > now() - interval '5 minutes'
      AND _read_at <= now() AND _read_at > now() - make_interval(secs => a.gate_max_age_s)
      AND _balance ~ '^[0-9]{1,20}$' AND _balance::numeric >= a.gate_min_raw::numeric
  ) THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', r.id, 'agentId', r.agent_id, 'createdAt', r.created_at, 'facts', r.facts, 'ai', r.ai
  ) ORDER BY r.created_at DESC) FROM (
    SELECT id, agent_id, created_at, facts, ai FROM public.depot_reports
    WHERE agent_id = _agent ORDER BY created_at DESC LIMIT 20
  ) r), '[]'::jsonb) ELSE NULL END
$$;
REVOKE ALL ON FUNCTION public.depot_holder_reports(uuid, uuid, integer, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.depot_holder_reports(uuid, uuid, integer, text, text, text, timestamptz) TO service_role;
