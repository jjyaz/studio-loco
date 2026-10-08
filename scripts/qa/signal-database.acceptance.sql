-- Disposable, paused database fixtures; every row is rolled back.
begin;
create temporary table loco_qa_scope (
  a uuid default gen_random_uuid(), b uuid default gen_random_uuid(),
  wa uuid default gen_random_uuid(), wb uuid default gen_random_uuid(),
  alert uuid default gen_random_uuid()
) on commit drop;
insert into loco_qa_scope default values;
grant select on loco_qa_scope to authenticated, anon;
insert into public.signal_watches(id,user_id,kind,label,status,rule)
select wa,a,'position','QA permission fixture A','paused','{}'::jsonb from loco_qa_scope
union all select wb,b,'position','QA permission fixture B','paused','{}'::jsonb from loco_qa_scope;
insert into public.signal_alerts(id,user_id,watch_id,watch_kind,revision,trigger,reason,dedupe_key,payload)
select alert,a,wa,'position',1,'edge','QA immutable evidence','qa:'||alert::text,'{}'::jsonb from loco_qa_scope;

do $$
begin
  if has_function_privilege('authenticated','public.signal_acquire_lease(uuid,integer)','EXECUTE') then
    raise exception 'Authenticated users can claim worker leases';
  end if;
  if has_function_privilege('anon','public.signal_verify_cron(text)','EXECUTE') then
    raise exception 'Anonymous callers can verify scheduler credentials';
  end if;
  if has_column_privilege('authenticated','public.signal_alerts','reason','UPDATE') or
     has_column_privilege('authenticated','public.signal_alerts','payload','UPDATE') then
    raise exception 'Client can rewrite monitoring evidence';
  end if;
  if not has_column_privilege('authenticated','public.signal_alerts','read_at','UPDATE') then
    raise exception 'Client cannot acknowledge own alert';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true) from loco_qa_scope;
do $$
declare n integer;
begin
  select count(*) into n from public.signal_watches;
  if n <> 1 then raise exception 'Own-user watch scope failed: %',n; end if;
  select count(*) into n from public.signal_alerts;
  if n <> 1 then raise exception 'Own-user alert scope failed: %',n; end if;
  delete from public.signal_watches where id = (select wb from loco_qa_scope);
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Cross-user watch deletion succeeded'; end if;
  update public.signal_watches set last_ok_at=now() where id=(select wa from loco_qa_scope);
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Client rewrote worker-owned health'; end if;
  update public.signal_alerts set read_at=now() where id=(select alert from loco_qa_scope);
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Own alert acknowledgement failed'; end if;
  begin
    update public.signal_alerts set reason='FORGED' where id=(select alert from loco_qa_scope);
    raise exception 'Client rewrote alert reason';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated')::text,true) from loco_qa_scope;
do $$
declare n integer;
begin
  select count(*) into n from public.signal_watches;
  if n <> 1 then raise exception 'Second-user watch scope failed'; end if;
  select count(*) into n from public.signal_alerts;
  if n <> 0 then raise exception 'Cross-user alert read succeeded'; end if;
end $$;

select set_config('request.jwt.claims','{}',true);
do $$
declare n integer;
begin
  select count(*) into n from public.signal_watches;
  if n <> 0 then raise exception 'Unauthenticated watch read succeeded'; end if;
end $$;

reset role;
insert into public.signal_watches(user_id,kind,label,status,rule)
select a,'position','QA cap fixture','paused','{}'::jsonb
from loco_qa_scope cross join generate_series(1,4);
do $$
begin
  begin
    insert into public.signal_watches(user_id,kind,label,status,rule)
    select a,'position','QA sixth refused','paused','{}'::jsonb from loco_qa_scope;
    raise exception 'Sixth watch was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Watch limit reached (5 per account)' then raise; end if;
  end;
end $$;
insert into public.signal_watches(user_id,kind,label,status,rule)
select b,'arb','QA arb fixture','paused','{}'::jsonb from loco_qa_scope;
do $$
begin
  begin
    insert into public.signal_watches(user_id,kind,label,status,rule)
    select b,'arb','QA second arb refused','paused','{}'::jsonb from loco_qa_scope;
    raise exception 'Second arb watch was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Only one arbitrage watch per account' then raise; end if;
  end;
end $$;
rollback;

