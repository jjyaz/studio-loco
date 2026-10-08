-- Never let a stale device overwrite newer private Flight Recorder evidence.
create or replace function public.recorder_monotonic_update()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.record->>'id' is distinct from new.id
     or jsonb_typeof(new.record->'updatedAt') is distinct from 'number'
     or to_timestamp((new.record->>'updatedAt')::numeric / 1000) is distinct from new.updated_at then
    raise exception 'Recorder identity/timestamp mismatch';
  end if;
  if tg_op = 'UPDATE' and new.updated_at <= old.updated_at then return null; end if;
  return new;
end;
$$;
revoke all on function public.recorder_monotonic_update() from public, anon, authenticated;
drop trigger if exists recorder_monotonic_update on public.recorder_records;
create trigger recorder_monotonic_update before insert or update on public.recorder_records
for each row execute function public.recorder_monotonic_update();

revoke update on public.signal_alerts from public, anon, authenticated;
grant update(read_at) on public.signal_alerts to authenticated;
revoke all on function public.signal_watch_cap() from public, anon, authenticated;
grant execute on function public.signal_watch_cap() to service_role;
