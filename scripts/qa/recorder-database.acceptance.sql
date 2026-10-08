begin;
do $$
declare
  scope uuid := gen_random_uuid();
  rid text := 'qa-recorder-' || gen_random_uuid()::text;
  n integer;
  t timestamptz := '2026-10-08T12:00:00Z';
begin
  insert into public.recorder_records(user_id,id,record,updated_at)
    values(scope,rid,jsonb_build_object('id',rid,'updatedAt',extract(epoch from t)*1000,'status','confirmed'),t);
  insert into public.recorder_records(user_id,id,record,updated_at)
    values(scope,rid,jsonb_build_object('id',rid,'updatedAt',extract(epoch from t - interval '1 minute')*1000,'status','unknown'),t - interval '1 minute')
    on conflict(user_id,id) do update set record=excluded.record,updated_at=excluded.updated_at;
  get diagnostics n = row_count;
  if n <> 0 or (select record->>'status' from public.recorder_records where user_id=scope and id=rid) <> 'confirmed' then raise exception 'Stale copy overwrote evidence'; end if;
  insert into public.recorder_records(user_id,id,record,updated_at)
    values(scope,rid,jsonb_build_object('id',rid,'updatedAt',extract(epoch from t + interval '1 minute')*1000,'status','failed'),t + interval '1 minute')
    on conflict(user_id,id) do update set record=excluded.record,updated_at=excluded.updated_at;
  if (select record->>'status' from public.recorder_records where user_id=scope and id=rid) <> 'failed' then raise exception 'Newer copy was not accepted'; end if;
  begin
    insert into public.recorder_records(user_id,id,record,updated_at)
      values(scope,rid || '-bad',jsonb_build_object('id','different','updatedAt',extract(epoch from t)*1000),t);
    raise exception 'Mismatched record identity was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Recorder identity/timestamp mismatch' then raise; end if;
  end;
end;
$$;
select 'PASS: stale copy rejected, newer copy accepted, identity mismatch rejected' as result;
rollback;
