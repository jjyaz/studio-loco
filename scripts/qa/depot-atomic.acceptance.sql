-- One transaction with an intentional final exception: no fixture is retained.
-- Tests deployed SQL boundaries, not browser signing or onchain receipt verification.
DO $$
DECLARE
  u uuid := '00000000-0000-4000-8000-00000000da01';
  a uuid := '00000000-0000-4000-8000-00000000da02';
  other_agent uuid := '00000000-0000-4000-8000-00000000da03';
  viewer uuid := '00000000-0000-4000-8000-00000000da04';
  owner_wallet text := '6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD';
  viewer_wallet text := 'So11111111111111111111111111111111111111112';
  image_hex text := '89504e470d0a1a0a';
  image_digest text := encode(sha256(decode('89504e470d0a1a0a', 'hex')), 'hex');
  body text := '{"name":"Rollback QA","agent":"da02"}';
  digest text;
  result jsonb;
  rejected boolean;
  launch jsonb;
BEGIN
  INSERT INTO public.depot_agents(id,user_id,name,wallet,wallet_verified_at)
  VALUES (a,u,'Rollback QA',owner_wallet,now()), (other_agent,u,'Rollback QA other',owner_wallet,now());
  digest := encode(sha256(convert_to(body,'UTF8')),'hex');
  result := public.depot_publish_metadata(u,a,digest,body,image_digest,'image/png',image_hex);
  ASSERT (result->>'version')::int = 1 AND NOT (result->>'reused')::boolean, 'first publication';
  result := public.depot_publish_metadata(u,a,digest,body,image_digest,'image/png',image_hex);
  ASSERT (result->>'version')::int = 1 AND (result->>'reused')::boolean, 'idempotent publication';
  ASSERT (SELECT count(*) FROM public.depot_metadata WHERE agent_id=a) = 1, 'reuse duplicated version';

  rejected := false;
  BEGIN PERFORM public.depot_publish_metadata(u,other_agent,digest,body,image_digest,'image/png',image_hex);
  EXCEPTION WHEN OTHERS THEN rejected := SQLERRM LIKE '%another agent%'; END;
  ASSERT rejected, 'cross-agent digest reuse';
  rejected := false;
  BEGIN PERFORM public.depot_publish_metadata(viewer,a,digest,body,image_digest,'image/png',image_hex);
  EXCEPTION WHEN OTHERS THEN rejected := SQLERRM LIKE '%verified owned agent%'; END;
  ASSERT rejected, 'wrong publication owner';
  rejected := false;
  BEGIN PERFORM public.depot_publish_metadata(u,a,repeat('0',64),body,image_digest,'image/png',image_hex);
  EXCEPTION WHEN OTHERS THEN rejected := SQLERRM LIKE '%integrity%'; END;
  ASSERT rejected, 'metadata digest mismatch';
  rejected := false;
  BEGIN UPDATE public.depot_metadata SET body='changed' WHERE agent_id=a;
  EXCEPTION WHEN OTHERS THEN rejected := SQLERRM LIKE '%immutable%'; END;
  ASSERT rejected, 'mutable published metadata';

  -- Invalid image MIME never leaves a published image or a new metadata version.
  BEGIN
    PERFORM public.depot_publish_metadata(u,a,encode(sha256(convert_to(body||'2','UTF8')),'hex'),body||'2',
      encode(sha256(decode('01','hex')),'hex'),'image/svg+xml','01');
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT NOT EXISTS (SELECT 1 FROM public.depot_images i WHERE i.digest=encode(sha256(decode('01','hex')),'hex')), 'orphan image';
  ASSERT (SELECT count(*) FROM public.depot_metadata WHERE agent_id=a)=1, 'failed publication retained version';

  INSERT INTO public.depot_reports(user_id,agent_id,pool,slot,observed_at,facts)
  VALUES (u,a,viewer_wallet,1,now(),'{"qa":"rollback only"}');
  INSERT INTO public.depot_viewer_wallets(user_id,agent_id,wallet) VALUES (viewer,a,viewer_wallet);
  UPDATE public.depot_agents SET visibility='public',report_policy='token-holders',gate_mint=viewer_wallet,gate_min_raw='10',gate_max_age_s=60 WHERE id=a;
  ASSERT jsonb_array_length(public.depot_holder_reports(viewer,a,1,viewer_wallet,viewer_wallet,'10',now()))=1, 'valid holder missing report';
  ASSERT public.depot_holder_reports(viewer,a,1,viewer_wallet,viewer_wallet,'9',now()) IS NULL, 'insufficient holder';
  ASSERT public.depot_holder_reports(viewer,a,1,owner_wallet,viewer_wallet,'10',now()) IS NULL, 'wrong viewer wallet';
  ASSERT public.depot_holder_reports(viewer,a,1,viewer_wallet,owner_wallet,'10',now()) IS NULL, 'wrong mint';
  ASSERT public.depot_holder_reports(viewer,a,1,viewer_wallet,viewer_wallet,'10',now()-interval '61 seconds') IS NULL, 'stale balance';
  ASSERT public.depot_holder_reports(viewer,a,1,viewer_wallet,viewer_wallet,'10',now()+interval '1 second') IS NULL, 'future balance';
  UPDATE public.depot_viewer_wallets SET verified_at=now()-interval '6 minutes' WHERE user_id=viewer AND agent_id=a;
  ASSERT public.depot_holder_reports(viewer,a,1,viewer_wallet,viewer_wallet,'10',now()) IS NULL, 'expired wallet proof';
  UPDATE public.depot_viewer_wallets SET verified_at=now() WHERE user_id=viewer AND agent_id=a;
  UPDATE public.depot_agents SET revision=2,gate_min_raw='100' WHERE id=a;
  ASSERT public.depot_holder_reports(viewer,a,1,viewer_wallet,viewer_wallet,'10',now()) IS NULL, 'in-flight obsolete policy';
  ASSERT jsonb_array_length(public.depot_holder_reports(viewer,a,2,viewer_wallet,viewer_wallet,'100',now()))=1, 'current policy';
  UPDATE public.depot_agents SET visibility='private' WHERE id=a;
  ASSERT public.depot_holder_reports(viewer,a,2,viewer_wallet,viewer_wallet,'100',now()) IS NULL, 'unpublished reports';

  -- Service RPC is a CAS boundary; chain receipt reconstruction is unit tested separately.
  launch := jsonb_build_object('cluster','mainnet-beta','mint',viewer_wallet,'signature','rollback-qa-signature',
    'config',viewer_wallet,'pool',viewer_wallet,'slot',1,'presetId','small-sol-20','presetVersion',1,
    'metadataDigest',digest,'verifiedAt',now());
  rejected := false;
  BEGIN PERFORM public.depot_link_launch(u,a,1,owner_wallet,digest,launch);
  EXCEPTION WHEN OTHERS THEN rejected := SQLERRM LIKE '%revision changed%'; END;
  ASSERT rejected, 'stale launch revision';
  result := public.depot_link_launch(u,a,2,owner_wallet,digest,launch);
  ASSERT result->>'status'='linked' AND (result->>'revision')::int=3, 'launch link';
  result := public.depot_link_launch(u,a,2,owner_wallet,digest,launch);
  ASSERT result->>'status'='already-linked' AND (result->>'revision')::int=3, 'idempotent launch link';
  rejected := false;
  BEGIN PERFORM public.depot_link_launch(u,a,3,owner_wallet,digest,launch||'{"signature":"different"}'::jsonb);
  EXCEPTION WHEN OTHERS THEN rejected := SQLERRM LIKE '%different verified launch%'; END;
  ASSERT rejected, 'launch overwritten';
  INSERT INTO public.depot_nonces(nonce,user_id,agent_id,wallet,purpose,domain,expires_at)
  VALUES (repeat('d',64),u,a,viewer_wallet,'controller','studioloco.cfd',now()+interval '5 minutes');
  ASSERT NOT public.depot_consume_nonce(repeat('d',64),u,a,viewer_wallet,'controller','studioloco.cfd'), 'launched controller rebound';
  ASSERT (SELECT wallet=owner_wallet AND revision=3 FROM public.depot_agents WHERE id=a), 'launched identity changed';

  ASSERT NOT has_function_privilege('anon','public.depot_publish_metadata(uuid,uuid,text,text,text,text,text)','EXECUTE'), 'anon publication';
  ASSERT NOT has_function_privilege('authenticated','public.depot_holder_reports(uuid,uuid,integer,text,text,text,timestamptz)','EXECUTE'), 'auth bypasses holder check';
  ASSERT NOT has_function_privilege('authenticated','public.depot_link_launch(uuid,uuid,integer,text,text,jsonb)','EXECUTE'), 'auth arbitrary launch link';
  ASSERT has_function_privilege('service_role','public.depot_publish_metadata(uuid,uuid,text,text,text,text,text)','EXECUTE'), 'service publication missing';
  RAISE EXCEPTION 'DEPOT ATOMIC ACCEPTANCE PASSED (forced rollback)';
END $$;
