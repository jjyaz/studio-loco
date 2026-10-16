-- Conductor extends the existing private Signal Box scheduler, lease, RLS and retention.
-- No new signer, public history API, token secret or external worker is introduced.
alter table public.signal_watches drop constraint if exists signal_watches_kind_check;
alter table public.signal_watches add constraint signal_watches_kind_check check (kind in ('position','arb','order','mission'));
create unique index if not exists conductor_one_copy_per_account on public.signal_watches (user_id, (rule->>'missionId')) where kind='mission';

create or replace function public.conductor_watch_guard() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and (old.kind='mission') is distinct from (new.kind='mission') then raise exception 'Watch kind is immutable'; end if;
  if new.kind<>'mission' then return new; end if;
  if new.rule->>'kind' is distinct from 'loco-hosted-mission' or new.rule->>'v' is distinct from '1' or not coalesce(new.rule->>'missionId' ~ '^[a-z0-9-]{8,70}$',false)
    or not coalesce(new.rule->'policy'->>'digest' ~ '^[a-f0-9]{64}$',false)
    or new.rule->'policy'->'policy'->>'adapter' is distinct from 'ordinary-dlmm-read-v1'
    or new.pool is distinct from (new.rule->'policy'->'policy'->'scope'->>'pool')
    or new.owner is distinct from (new.rule->'policy'->'policy'->'scope'->>'owner')
    or new.position is distinct from (new.rule->'policy'->'policy'->'scope'->>'position')
    or pg_column_size(new.rule)>20000 then raise exception 'Invalid hosted mission binding'; end if;
  if new.expires_at is distinct from to_timestamp((new.rule->'policy'->'policy'->>'expiresAt')::numeric/1000) then raise exception 'Hosted expiry must match sealed policy'; end if;
  if tg_op='UPDATE' then
    if new.user_id<>old.user_id or new.rule->>'missionId' is distinct from old.rule->>'missionId' or new.rule->'policy'->'policy'->'scope' is distinct from old.rule->'policy'->'policy'->'scope' then raise exception 'Hosted mission scope is immutable'; end if;
    if (new.rule is distinct from old.rule or new.status<>old.status or new.expires_at<>old.expires_at) and new.revision<>old.revision+1 then raise exception 'Hosted changes require next revision'; end if;
  end if;
  return new;
end $$;
drop trigger if exists conductor_watch_guard on public.signal_watches;
create trigger conductor_watch_guard before insert or update on public.signal_watches for each row execute function public.conductor_watch_guard();
revoke execute on function public.conductor_watch_guard() from public,anon,authenticated;

create or replace function public.conductor_observer_change(_user uuid,_watch uuid,_revision int,_action text,_rule jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.signal_watches;
begin
  select * into w from public.signal_watches where id=_watch and user_id=_user and kind='mission' for update;
  if not found or w.revision<>_revision then return jsonb_build_object('ok',false); end if;
  if _action='remove' then delete from public.signal_watches where id=w.id; return jsonb_build_object('ok',true); end if;
  if _action not in ('pause','resume','revise') then return jsonb_build_object('ok',false); end if;
  if _action='resume' and w.expires_at<=now() then return jsonb_build_object('ok',false); end if;
  if _action='revise' then
    if (_rule->'policy'->>'revision')::bigint <= (w.rule->'policy'->>'revision')::bigint or (_rule->'policy'->>'sealedAt')::bigint <= (w.rule->'policy'->>'sealedAt')::bigint then return jsonb_build_object('ok',false); end if;
    if to_timestamp((_rule->'policy'->'policy'->>'expiresAt')::numeric/1000)<=now() then return jsonb_build_object('ok',false); end if;
  end if;
  update public.signal_watches set revision=w.revision+1,
    status=case when _action='pause' then 'paused' when _action='resume' then 'active' else 'paused' end,
    rule=case when _action='revise' then _rule else w.rule end,
    expires_at=case when _action='revise' then to_timestamp((_rule->'policy'->'policy'->>'expiresAt')::numeric/1000) else w.expires_at end,
    updated_at=now() where id=w.id;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.conductor_observer_commit(_holder uuid,_watch uuid,_revision int,_tick bigint,_ok boolean,_summary jsonb,_error text,_out_run jsonb,_last_proposed jsonb,_alert jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.signal_watches; previous_count bigint;
begin
  -- Match the existing lock order: lease, then watch. No stale or expired holder may write.
  perform 1 from private.signal_lease where id=1 and holder=_holder and expires_at>now() for update;
  if not found then return jsonb_build_object('committed',false,'reason','lease lost'); end if;
  select * into w from public.signal_watches where id=_watch for update;
  if not found then return jsonb_build_object('committed',false,'reason','deleted'); end if;
  if w.kind<>'mission' or w.revision<>_revision then return jsonb_build_object('committed',false,'reason','revision changed'); end if;
  if w.status<>'active' or w.expires_at<=now() then return jsonb_build_object('committed',false,'reason','paused or expired'); end if;
  if _summary->>'kind' is distinct from 'loco-hosted-sample' or _summary->'policy' is distinct from w.rule->'policy' or pg_column_size(_summary)>100000 or _alert is not null then return jsonb_build_object('committed',false,'reason','scope'); end if;
  if _ok then
    if _summary->'snapshot'->'scope' is distinct from w.rule->'policy'->'policy'->'scope' or _summary->'snapshot'->>'rpcKind' is distinct from 'server' or _summary->'error' is distinct from 'null'::jsonb then return jsonb_build_object('committed',false,'reason','snapshot'); end if;
  elsif _summary->'snapshot' is distinct from 'null'::jsonb or _error is null or _summary->>'error' is distinct from _error then return jsonb_build_object('committed',false,'reason','gap'); end if;
  previous_count=coalesce((w.out_run->>'count')::bigint,0);
  if _out_run->>'kind' is distinct from 'mission-observation-counter' or (_out_run->>'count')::bigint is distinct from previous_count+1 then return jsonb_build_object('committed',false,'reason','counter'); end if;
  return public.signal_commit(_holder,_watch,_revision,_tick,_ok,_summary,_error,_out_run,'{}'::jsonb,null);
end $$;
revoke execute on function public.conductor_observer_change(uuid,uuid,int,text,jsonb), public.conductor_observer_commit(uuid,uuid,int,bigint,boolean,jsonb,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.conductor_observer_change(uuid,uuid,int,text,jsonb), public.conductor_observer_commit(uuid,uuid,int,bigint,boolean,jsonb,text,jsonb,jsonb,jsonb) to service_role;
