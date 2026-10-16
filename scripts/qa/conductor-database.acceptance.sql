-- Real PostgreSQL/RLS/CAS acceptance. All public fixture rows/lease changes roll back.
begin;
do $$
declare
  uid uuid:=gen_random_uuid(); other_uid uuid:=gen_random_uuid(); wid uuid:=gen_random_uuid(); v_holder uuid:=gen_random_uuid();
  scope jsonb; policy jsonb; rule jsonb; summary jsonb; result jsonb; count_rows int; visible boolean;
  expires timestamptz:=date_trunc('milliseconds',now()+interval '1 hour');
begin
  if has_function_privilege('anon','public.conductor_observer_change(uuid,uuid,integer,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.conductor_observer_commit(uuid,uuid,integer,bigint,boolean,jsonb,text,jsonb,jsonb,jsonb)','execute') then raise exception 'Private observer RPC exposed'; end if;
  scope=jsonb_build_object('pool','5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6','owner','6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD','mintX','So11111111111111111111111111111111111111112','mintY','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','decimalsX',9,'decimalsY',6,'binStep',4,'position',null,'journeyId',null);
  policy=jsonb_build_object('revision',1,'sealedAt',(extract(epoch from now())*1000)::bigint,'digest',repeat('a',64),'policy',jsonb_build_object('v',1,'adapter','ordinary-dlmm-read-v1','scope',scope,'expiresAt',(extract(epoch from expires)*1000)::bigint));
  rule=jsonb_build_object('v',1,'kind','loco-hosted-mission','missionId','mission-database-qa','policy',policy);
  insert into public.signal_watches(id,user_id,kind,label,pool,owner,rule,expires_at)
    values(wid,uid,'mission','ROLLBACK SQL QA','5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6','6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD',rule,expires);
  perform set_config('request.jwt.claim.sub',other_uid::text,true);
  execute 'set local role authenticated';
  select exists(select 1 from public.signal_watches where id=wid) into visible;
  execute 'reset role';
  if visible then raise exception 'Other account can read a private mission'; end if;
  perform set_config('request.jwt.claim.sub',uid::text,true);
  execute 'set local role authenticated';
  select exists(select 1 from public.signal_watches where id=wid) into visible;
  execute 'reset role';
  if not visible then raise exception 'Owner account cannot read its mission'; end if;
  update private.signal_lease set holder=v_holder,expires_at=now()+interval '2 minutes' where id=1;
  summary=jsonb_build_object('v',1,'kind','loco-hosted-sample','policy',policy,'snapshot',null,'error','SQL read-gap fixture');
  result=public.conductor_observer_change(other_uid,wid,1,'pause',rule);
  if result->>'ok'<>'false' then raise exception 'Other user mutated mission'; end if;
  result=public.conductor_observer_commit(gen_random_uuid(),wid,1,null,false,summary,'SQL read-gap fixture',jsonb_build_object('v',1,'kind','mission-observation-counter','count',1),'{}',null);
  if result->>'committed'<>'false' then raise exception 'Wrong lease committed'; end if;
  result=public.conductor_observer_change(uid,wid,1,'pause',rule);
  if result->>'ok'<>'true' then raise exception 'Pause failed'; end if;
  result=public.conductor_observer_commit(v_holder,wid,1,null,false,summary,'SQL read-gap fixture',jsonb_build_object('v',1,'kind','mission-observation-counter','count',1),'{}',null);
  if result->>'committed'<>'false' then raise exception 'Stale paused work committed'; end if;
  result=public.conductor_observer_change(uid,wid,2,'resume',rule);
  if result->>'ok'<>'true' then raise exception 'Resume failed'; end if;
  result=public.conductor_observer_commit(v_holder,wid,3,null,false,summary,'SQL read-gap fixture',jsonb_build_object('v',1,'kind','mission-observation-counter','count',1),'{}',null);
  if result->>'committed'<>'true' then raise exception 'Valid leased gap not committed: %',result; end if;
  result=public.conductor_observer_commit(v_holder,wid,3,null,false,summary,'SQL read-gap fixture',jsonb_build_object('v',1,'kind','mission-observation-counter','count',1),'{}',null);
  if result->>'committed'<>'false' then raise exception 'Repeated counter accepted'; end if;
  select count(*) into count_rows from public.signal_observations where watch_id=wid;
  if count_rows<>1 then raise exception 'Stale/replayed work produced duplicate evidence'; end if;
  perform set_config('request.jwt.claim.sub',other_uid::text,true);
  execute 'set local role authenticated';
  select exists(select 1 from public.signal_observations where watch_id=wid) into visible;
  execute 'reset role';
  if visible then raise exception 'Other account can read private samples'; end if;
  update private.signal_lease set expires_at=now()-interval '1 second' where id=1;
  result=public.conductor_observer_commit(v_holder,wid,3,null,false,summary,'SQL read-gap fixture',jsonb_build_object('v',1,'kind','mission-observation-counter','count',2),'{}',null);
  if result->>'committed'<>'false' then raise exception 'Expired lease committed'; end if;
  update private.signal_lease set expires_at=now()+interval '2 minutes' where id=1;
  result=public.conductor_observer_change(uid,wid,3,'remove',rule);
  if result->>'ok'<>'true' then raise exception 'Removal failed'; end if;
  result=public.conductor_observer_commit(v_holder,wid,3,null,false,summary,'SQL read-gap fixture',jsonb_build_object('v',1,'kind','mission-observation-counter','count',2),'{}',null);
  if result->>'committed'<>'false' then raise exception 'Deleted mission was resurrected'; end if;
  raise notice 'PASS: private grants/RLS, owner isolation, lease, pause/resume CAS, counter replay, gaps and deletion';
end $$;
rollback;
