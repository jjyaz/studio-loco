CREATE TABLE public.depot_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 600),
  mission text NOT NULL DEFAULT 'scout' CHECK (mission IN ('scout')),
  wallet text CHECK (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  wallet_verified_at timestamptz,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  published_at timestamptz,
  report_policy text NOT NULL DEFAULT 'public' CHECK (report_policy IN ('public','token-holders')),
  gate_mint text CHECK (gate_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  gate_min_raw text CHECK (gate_min_raw ~ '^[1-9][0-9]{0,19}$'),
  gate_max_age_s integer NOT NULL DEFAULT 60 CHECK (gate_max_age_s BETWEEN 10 AND 300),
  launch jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility = 'private' OR wallet_verified_at IS NOT NULL),
  CHECK (report_policy = 'public' OR (gate_mint IS NOT NULL AND gate_min_raw IS NOT NULL))
);
CREATE INDEX depot_agents_user ON public.depot_agents(user_id);
GRANT SELECT ON public.depot_agents TO authenticated;
GRANT ALL ON public.depot_agents TO service_role;
ALTER TABLE public.depot_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own agents read" ON public.depot_agents FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.depot_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES public.depot_agents(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('controller','viewer')),
  domain text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX depot_nonces_user ON public.depot_nonces(user_id, issued_at);
GRANT ALL ON public.depot_nonces TO service_role;
ALTER TABLE public.depot_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.depot_viewer_wallets (
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES public.depot_agents(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);
GRANT SELECT ON public.depot_viewer_wallets TO authenticated;
GRANT ALL ON public.depot_viewer_wallets TO service_role;
ALTER TABLE public.depot_viewer_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own viewer wallets read" ON public.depot_viewer_wallets FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.depot_images (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.depot_images TO service_role;
ALTER TABLE public.depot_images ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.depot_metadata (
  digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL,
  agent_id uuid REFERENCES public.depot_agents(id) ON DELETE SET NULL,
  version integer NOT NULL CHECK (version >= 1),
  body text NOT NULL CHECK (octet_length(body) <= 4096),
  image_digest text NOT NULL REFERENCES public.depot_images(digest),
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX depot_metadata_agent ON public.depot_metadata(agent_id, version);
GRANT SELECT ON public.depot_metadata TO authenticated;
GRANT ALL ON public.depot_metadata TO service_role;
ALTER TABLE public.depot_metadata ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own metadata read" ON public.depot_metadata FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.depot_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'published content is immutable'; END IF;
  IF TG_TABLE_NAME = 'depot_metadata' AND (NEW.digest, NEW.body, NEW.image_digest, NEW.version, NEW.user_id) IS DISTINCT FROM (OLD.digest, OLD.body, OLD.image_digest, OLD.version, OLD.user_id) THEN
    RAISE EXCEPTION 'published metadata is immutable';
  END IF;
  IF TG_TABLE_NAME = 'depot_images' THEN RAISE EXCEPTION 'published images are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER depot_metadata_immutable BEFORE UPDATE OR DELETE ON public.depot_metadata FOR EACH ROW EXECUTE FUNCTION public.depot_immutable_guard();
CREATE TRIGGER depot_images_immutable BEFORE UPDATE OR DELETE ON public.depot_images FOR EACH ROW EXECUTE FUNCTION public.depot_immutable_guard();

CREATE TABLE public.depot_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES public.depot_agents(id) ON DELETE CASCADE,
  pool text NOT NULL,
  slot bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  facts jsonb NOT NULL CHECK (pg_column_size(facts) < 60000),
  ai jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX depot_reports_agent ON public.depot_reports(agent_id, created_at DESC);
CREATE INDEX depot_reports_user ON public.depot_reports(user_id, created_at DESC);
GRANT SELECT ON public.depot_reports TO authenticated;
GRANT ALL ON public.depot_reports TO service_role;
ALTER TABLE public.depot_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reports read" ON public.depot_reports FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Atomic single-use proof consumption (service role only). Binds session user, agent, wallet, purpose, domain, expiry.
CREATE OR REPLACE FUNCTION public.depot_consume_nonce(_nonce text, _user uuid, _agent uuid, _wallet text, _purpose text, _domain text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n public.depot_nonces;
BEGIN
  UPDATE public.depot_nonces SET consumed_at = now()
   WHERE nonce = _nonce AND consumed_at IS NULL AND expires_at > now() AND issued_at <= now()
     AND user_id = _user AND agent_id = _agent AND wallet = _wallet AND purpose = _purpose AND domain = _domain
  RETURNING * INTO n;
  IF NOT FOUND THEN RETURN false; END IF;
  IF _purpose = 'controller' THEN
    UPDATE public.depot_agents SET wallet = _wallet, wallet_verified_at = now(), revision = revision + 1, updated_at = now()
     WHERE id = _agent AND user_id = _user;
    IF NOT FOUND THEN RAISE EXCEPTION 'agent not owned'; END IF;
  ELSE
    INSERT INTO public.depot_viewer_wallets(user_id, agent_id, wallet, verified_at) VALUES (_user, _agent, _wallet, now())
    ON CONFLICT (user_id, agent_id) DO UPDATE SET wallet = EXCLUDED.wallet, verified_at = now();
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.depot_consume_nonce(text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.depot_consume_nonce(text, uuid, uuid, text, text, text) TO service_role;

-- Whitelisted public reads (anon-callable). Only explicitly published fields.
CREATE OR REPLACE FUNCTION public.depot_public_passport(_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description, 'mission', a.mission,
    'wallet', a.wallet, 'walletVerifiedAt', a.wallet_verified_at, 'publishedAt', a.published_at, 'revision', a.revision,
    'reportPolicy', a.report_policy, 'gateMint', a.gate_mint, 'gateMinRaw', a.gate_min_raw,
    'metadata', COALESCE((SELECT jsonb_agg(jsonb_build_object('digest', m.digest, 'version', m.version, 'publishedAt', m.published_at) ORDER BY m.version)
                 FROM public.depot_metadata m WHERE m.agent_id = a.id), '[]'::jsonb))
  FROM public.depot_agents a WHERE a.id = _id AND a.visibility = 'public' AND a.wallet_verified_at IS NOT NULL
$$;
CREATE OR REPLACE FUNCTION public.depot_public_metadata(_digest text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT body FROM public.depot_metadata WHERE digest = _digest
$$;
CREATE OR REPLACE FUNCTION public.depot_public_image(_digest text)
RETURNS TABLE(mime text, b64 text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.mime, encode(i.bytes, 'base64') FROM public.depot_images i
   WHERE i.digest = _digest AND EXISTS (SELECT 1 FROM public.depot_metadata m WHERE m.image_digest = i.digest)
$$;
REVOKE ALL ON FUNCTION public.depot_public_passport(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.depot_public_metadata(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.depot_public_image(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.depot_public_passport(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.depot_public_metadata(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.depot_public_image(text) TO anon, authenticated, service_role;