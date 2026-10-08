
create extension if not exists pg_cron;
create extension if not exists pg_net;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Watches
create table public.signal_watches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('position','arb')),
  label text not null default '' check (char_length(label) <= 80),
  cluster text not null default 'mainnet-beta' check (cluster = 'mainnet-beta'),
  position text, pool text, owner text,
  rule jsonb not null,
  status text not null default 'active' check (status in ('active','paused')),
  revision integer not null default 1,
  expires_at timestamptz not null default now() + interval '7 days',
  out_run jsonb,
  last_proposed jsonb not null default '{}'::jsonb,
  last_run_at timestamptz, last_ok_at timestamptz, last_error text,
  consecutive_errors integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.signal_watches (user_id);
create index on public.signal_watches (status, expires_at);
grant select, delete on public.signal_watches to authenticated;
grant all on public.signal_watches to service_role;
alter table public.signal_watches enable row level security;
create policy "own watches read" on public.signal_watches for select to authenticated using (auth.uid() = user_id);
create policy "own watches delete" on public.signal_watches for delete to authenticated using (auth.uid() = user_id);

create or replace function public.signal_watch_cap() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.signal_watches where user_id = new.user_id) >= 5 then
    raise exception 'Watch limit reached (5 per account)';
  end if;
  if new.kind = 'arb' and (select count(*) from public.signal_watches where user_id = new.user_id and kind = 'arb') >= 1 then
    raise exception 'Only one arbitrage watch per account';
  end if;
  return new;
end $$;
create trigger signal_watch_cap before insert on public.signal_watches for each row execute function public.signal_watch_cap();

-- Observations
create table public.signal_observations (
  id bigserial primary key,
  watch_id uuid not null references public.signal_watches(id) on delete cascade,
  user_id uuid not null,
  revision integer not null,
  tick_id bigint,
  observed_at timestamptz not null default now(),
  ok boolean not null,
  summary jsonb not null default '{}'::jsonb,
  error text
);
create index on public.signal_observations (watch_id, observed_at desc);
grant select on public.signal_observations to authenticated;
grant all on public.signal_observations to service_role;
grant usage on sequence public.signal_observations_id_seq to service_role;
alter table public.signal_observations enable row level security;
create policy "own observations" on public.signal_observations for select to authenticated using (auth.uid() = user_id);

-- Alerts
create table public.signal_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  watch_id uuid references public.signal_watches(id) on delete set null,
  watch_kind text not null,
  revision integer not null,
  trigger text not null,
  reason text not null,
  dedupe_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_status text
);
create index on public.signal_alerts (user_id, created_at desc);
grant select, delete on public.signal_alerts to authenticated;
grant update (read_at) on public.signal_alerts to authenticated;
grant all on public.signal_alerts to service_role;
alter table public.signal_alerts enable row level security;
create policy "own alerts read" on public.signal_alerts for select to authenticated using (auth.uid() = user_id);
create policy "own alerts mark" on public.signal_alerts for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own alerts delete" on public.signal_alerts for delete to authenticated using (auth.uid() = user_id);

-- Push subscriptions
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique check (char_length(endpoint) <= 1024),
  p256dh text not null, auth text not null,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz, last_error text
);
grant select, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;
alter table public.push_subscriptions enable row level security;
create policy "own subs read" on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);
create policy "own subs delete" on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);

-- Flight recorder cloud copy
create table public.recorder_records (
  user_id uuid not null,
  id text not null check (char_length(id) <= 80),
  record jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
grant select, insert, update, delete on public.recorder_records to authenticated;
grant all on public.recorder_records to service_role;
alter table public.recorder_records enable row level security;
create policy "own records read" on public.recorder_records for select to authenticated using (auth.uid() = user_id);
create policy "own records insert" on public.recorder_records for insert to authenticated with check (auth.uid() = user_id and pg_column_size(record) < 200000);
create policy "own records update" on public.recorder_records for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id and pg_column_size(record) < 200000);
create policy "own records delete" on public.recorder_records for delete to authenticated using (auth.uid() = user_id);

-- Tick health (no user data)
create table public.signal_ticks (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  processed integer not null default 0,
  errors integer not null default 0,
  alerts integer not null default 0,
  note text
);
grant select on public.signal_ticks to authenticated;
grant all on public.signal_ticks to service_role;
grant usage on sequence public.signal_ticks_id_seq to service_role;
alter table public.signal_ticks enable row level security;
create policy "tick health readable" on public.signal_ticks for select to authenticated using (true);

-- Lease + cron token (private)
create table private.signal_lease (id int primary key check (id = 1), holder uuid, expires_at timestamptz not null default 'epoch');
insert into private.signal_lease (id) values (1);
create table private.cron_token (id int primary key check (id = 1), token text not null);
insert into private.cron_token values (1, encode(extensions.gen_random_bytes(32), 'hex'));

create or replace function public.signal_verify_cron(_token text) returns boolean language sql stable security definer set search_path = private as $$
  select exists (select 1 from private.cron_token where id = 1 and token = _token)
$$;
create or replace function public.signal_acquire_lease(_holder uuid, _ttl_seconds int) returns boolean language plpgsql security definer set search_path = private as $$
declare n int;
begin
  update private.signal_lease set holder = _holder, expires_at = now() + make_interval(secs => _ttl_seconds)
   where id = 1 and (expires_at < now() or holder = _holder);
  get diagnostics n = row_count;
  return n = 1;
end $$;
create or replace function public.signal_release_lease(_holder uuid) returns void language sql security definer set search_path = private as $$
  update private.signal_lease set expires_at = 'epoch' where id = 1 and holder = _holder
$$;

-- Atomic commit: only lands if the watch is still active, unexpired and at the same revision.
create or replace function public.signal_commit(_watch uuid, _revision int, _tick bigint, _ok boolean, _summary jsonb, _error text,
  _out_run jsonb, _last_proposed jsonb, _alert jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.signal_watches; aid uuid;
begin
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

revoke execute on function public.signal_verify_cron(text), public.signal_acquire_lease(uuid,int), public.signal_release_lease(uuid),
  public.signal_commit(uuid,int,bigint,boolean,jsonb,text,jsonb,jsonb,jsonb), public.signal_watch_cap() from public, anon, authenticated;
grant execute on function public.signal_verify_cron(text), public.signal_acquire_lease(uuid,int), public.signal_release_lease(uuid),
  public.signal_commit(uuid,int,bigint,boolean,jsonb,text,jsonb,jsonb,jsonb) to service_role;
