-- Preserve live safeguards applied by review: alert UPDATE limited to read_at; locked watch cap.
revoke update on public.signal_alerts from authenticated;
grant update (read_at) on public.signal_alerts to authenticated;

create or replace function public.signal_watch_cap() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 918271));
  if (select count(*) from public.signal_watches where user_id = new.user_id) >= 5 then
    raise exception 'Watch limit reached (5 per account)';
  end if;
  if new.kind = 'arb' and
     (select count(*) from public.signal_watches where user_id = new.user_id and kind = 'arb') >= 1 then
    raise exception 'Only one arbitrage watch per account';
  end if;
  return new;
end;
$$;

-- Retire the ungated commit signature.
drop function if exists public.signal_commit(uuid, integer, bigint, boolean, jsonb, text, jsonb, jsonb, jsonb);

-- Commit only while the caller holds the unexpired worker lease (lease row locked for the whole commit).
create or replace function public.signal_commit(_holder uuid, _watch uuid, _revision int, _tick bigint, _ok boolean, _summary jsonb, _error text,
  _out_run jsonb, _last_proposed jsonb, _alert jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.signal_watches; aid uuid; l record;
begin
  select holder, expires_at into l from private.signal_lease where id = 1 for update;
  if not found or l.holder is distinct from _holder or l.expires_at <= now() then
    return jsonb_build_object('committed', false, 'reason', 'lease lost');
  end if;
  select * into w from public.signal_watches where id = _watch for update;
  if not found then return jsonb_build_object('committed', false, 'reason', 'deleted'); end if;
  if w.revision <> _revision then return jsonb_build_object('committed', false, 'reason', 'revision changed'); end if;
  if w.status <> 'active' then return jsonb_build_object('committed', false, 'reason', 'paused'); end if;
  if w.expires_at < now() then return jsonb_build_object('committed', false, 'reason', 'expired'); end if;
  insert into public.signal_observations (watch_id, user_id, revision, tick_id, ok, summary, error)
    values (_watch, w.user_id, _revision, _tick, _ok, coalesce(_summary, '{}'::jsonb), _error);
  delete from public.signal_observations where watch_id = _watch and id not in
    (select id from public.signal_observations where watch_id = _watch order by observed_at desc limit 60);
  update public.signal_watches set last_run_at = now(),
    last_ok_at = case when _ok then now() else last_ok_at end,
    last_error = case when _ok then null else _error end,
    consecutive_errors = case when _ok then 0 else consecutive_errors + 1 end,
    out_run = _out_run, last_proposed = coalesce(_last_proposed, last_proposed)
    where id = _watch;
  if _alert is not null then
    insert into public.signal_alerts (user_id, watch_id, watch_kind, revision, trigger, reason, dedupe_key, payload)
      values (w.user_id, _watch, w.kind, _revision, _alert->>'trigger', _alert->>'reason', _alert->>'dedupe_key', coalesce(_alert->'payload', '{}'::jsonb))
      on conflict (dedupe_key) do nothing returning id into aid;
  end if;
  return jsonb_build_object('committed', true, 'alert_id', aid);
end $$;

-- Server-only VAPID seed, generated inside the database.
create table if not exists private.push_config (id int primary key check (id = 1), seed text not null);
insert into private.push_config (id, seed) values (1, encode(extensions.gen_random_bytes(32), 'hex')) on conflict (id) do nothing;
revoke all on private.push_config from public, anon, authenticated;

create or replace function public.signal_push_seed() returns text language sql stable security definer set search_path = private, pg_temp as $$
  select seed from private.push_config where id = 1
$$;

-- Atomic, owner-scoped push subscription save with a 5-device cap.
create or replace function public.signal_save_push(_user uuid, _endpoint text, _p256dh text, _auth text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare other uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(_user::text, 918272));
  select user_id into other from public.push_subscriptions where endpoint = _endpoint for update;
  if found then
    if other <> _user then return 'conflict'; end if;
    update public.push_subscriptions set p256dh = _p256dh, auth = _auth, last_error = null where endpoint = _endpoint and user_id = _user;
    return 'updated';
  end if;
  if (select count(*) from public.push_subscriptions where user_id = _user) >= 5 then return 'cap'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (_user, _endpoint, _p256dh, _auth);
  return 'created';
end $$;

-- Worker / server-only RPCs.
revoke execute on function public.signal_commit(uuid, uuid, int, bigint, boolean, jsonb, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.signal_push_seed() from public, anon, authenticated;
revoke execute on function public.signal_save_push(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.signal_acquire_lease(uuid, int) from public, anon, authenticated;
revoke execute on function public.signal_release_lease(uuid) from public, anon, authenticated;
revoke execute on function public.signal_verify_cron(text) from public, anon, authenticated;
grant execute on function public.signal_commit(uuid, uuid, int, bigint, boolean, jsonb, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.signal_push_seed() to service_role;
grant execute on function public.signal_save_push(uuid, text, text, text) to service_role;
grant execute on function public.signal_acquire_lease(uuid, int) to service_role;
grant execute on function public.signal_release_lease(uuid) to service_role;
grant execute on function public.signal_verify_cron(text) to service_role;