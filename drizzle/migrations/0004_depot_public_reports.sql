CREATE OR REPLACE FUNCTION public.depot_public_reports(_agent uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'agentId', r.agent_id, 'createdAt', r.created_at, 'facts', r.facts, 'ai', r.ai) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM public.depot_reports WHERE agent_id = _agent ORDER BY created_at DESC LIMIT 20) r
  WHERE EXISTS (SELECT 1 FROM public.depot_agents a WHERE a.id = _agent AND a.visibility = 'public'
                AND a.wallet_verified_at IS NOT NULL AND a.report_policy = 'public')
$$;
REVOKE ALL ON FUNCTION public.depot_public_reports(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.depot_public_reports(uuid) TO anon, authenticated, service_role;