-- RAMAGAN V1 TEST MIGRATION 002: product & receiving services
-- Requires 001_v1_central.sql.
-- DO NOT use for a regulated retail business until licensed operations are
-- verified. sales_enabled remains FALSE unless expressly activated by an
-- authorized database administrator after all release gates.
--
-- Security design:
-- * only owner/manager members may create products and receive lots
-- * client roles have SELECT-only access to tables (no direct INSERT)
-- * private SECURITY DEFINER functions check authenticated actor + store role
-- * all stock changes are atomic + append-only and tied to an actor
-- * first receive for a brand-new lot only (unique store/lot_code)

create or replace function ramagan_private.create_product_impl(
  p_store_id uuid,
  p_sku text,
  p_name text,
  p_category text,
  p_price_satang_per_gram bigint
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_product_id uuid;
begin
  if v_actor is null or p_store_id is null then
    raise exception 'Login required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ramagan_members m
     where m.user_id = v_actor and m.store_id = p_store_id
       and m.is_active and m.role in ('owner', 'manager')
  ) then
    raise exception 'Owner or manager permission required' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_sku)), 0) not between 1 and 60
      or coalesce(length(trim(p_name)), 0) not between 1 and 200 then
    raise exception 'SKU/name are required' using errcode = '22023';
  end if;
  if p_category is null or length(trim(p_category)) > 60 then
    raise exception 'Invalid category' using errcode = '22023';
  end if;
  if p_price_satang_per_gram is null or
     p_price_satang_per_gram < 0 or p_price_satang_per_gram > 100000000 then
    raise exception 'Invalid satang price' using errcode = '22023';
  end if;

  insert into public.ramagan_products (
    store_id, sku, name, category, price_satang_per_gram
  ) values (
    p_store_id, trim(p_sku), trim(p_name), trim(p_category), p_price_satang_per_gram
  ) returning id into v_product_id;

  return jsonb_build_object('product_id', v_product_id, 'created', true);
end
$$;

create or replace function public.ramagan_create_product(
  p_store_id uuid,
  p_sku text,
  p_name text,
  p_category text,
  p_price_satang_per_gram bigint
) returns jsonb
language sql security invoker set search_path = ''
as $$
  select ramagan_private.create_product_impl(
    p_store_id, p_sku, p_name, p_category, p_price_satang_per_gram
  );
$$;

create or replace function ramagan_private.receive_lot_impl(
  p_store_id uuid,
  p_product_id uuid,
  p_lot_code text,
  p_supplier_name text,
  p_supplier_document_ref text,
  p_quantity_mg bigint,
  p_expires_on date,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_lot_id uuid;
  v_event_id uuid;
begin
  if v_actor is null or p_store_id is null then
    raise exception 'Login required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ramagan_members m
     where m.user_id = v_actor and m.store_id = p_store_id
       and m.is_active and m.role in ('owner', 'manager')
  ) then
    raise exception 'Owner or manager permission required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ramagan_products p
     where p.id = p_product_id and p.store_id = p_store_id and p.active
  ) then
    raise exception 'Unknown or inactive product' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_lot_code)), 0) not between 1 and 100
    or coalesce(length(trim(p_supplier_name)), 0) not between 1 and 200
    or coalesce(length(trim(p_supplier_document_ref)), 0) not between 1 and 200 then
    raise exception 'Lot code, supplier and document reference required' using errcode = '22023';
  end if;
  if p_quantity_mg is null or p_quantity_mg < 1 or p_quantity_mg > 100000000 then
    raise exception 'Receipt quantity must be 0.001 to 100,000 grams' using errcode = '22023';
  end if;
  if p_expires_on is not null
    and p_expires_on < (now() at time zone 'Asia/Bangkok')::date then
    raise exception 'Cannot receive an expired lot' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_reason)), 0) not between 1 and 500 then
    raise exception 'Stock movement reason required' using errcode = '22023';
  end if;

  -- The unique (store_id, lot_code) index prevents duplicate RECEIVE events.
  -- If any statement fails, PostgreSQL rolls the entire RPC transaction back.
  insert into public.ramagan_lots (
    store_id, product_id, lot_code,
    supplier_name, supplier_document_ref, expires_on
  ) values (
    p_store_id, p_product_id, trim(p_lot_code),
    trim(p_supplier_name), trim(p_supplier_document_ref), p_expires_on
  ) returning id into v_lot_id;

  insert into public.ramagan_lot_balances(lot_id, quantity_mg)
  values(v_lot_id, p_quantity_mg);

  insert into public.ramagan_ledger_events(
    store_id, lot_id, actor_user_id,
    event_type, quantity_delta_mg, reason
  ) values (
    p_store_id, v_lot_id, v_actor, 'RECEIVE', p_quantity_mg, trim(p_reason)
  ) returning id into v_event_id;

  return jsonb_build_object(
    'lot_id', v_lot_id, 'event_id', v_event_id, 'quantity_mg', p_quantity_mg
  );
end
$$;

create or replace function public.ramagan_receive_lot(
  p_store_id uuid,
  p_product_id uuid,
  p_lot_code text,
  p_supplier_name text,
  p_supplier_document_ref text,
  p_quantity_mg bigint,
  p_expires_on date,
  p_reason text
) returns jsonb
language sql security invoker set search_path = ''
as $$
  select ramagan_private.receive_lot_impl(
    p_store_id, p_product_id, p_lot_code,
    p_supplier_name, p_supplier_document_ref, p_quantity_mg,
    p_expires_on, p_reason
  );
$$;

-- PUBLIC EXECUTE is the Postgres default and must be revoked explicitly.
revoke all on function public.ramagan_create_product(uuid,text,text,text,bigint)
  from public, anon, authenticated;
revoke all on function ramagan_private.create_product_impl(uuid,text,text,text,bigint)
  from public, anon, authenticated;
revoke all on function public.ramagan_receive_lot(uuid,uuid,text,text,text,bigint,date,text)
  from public, anon, authenticated;
revoke all on function ramagan_private.receive_lot_impl(uuid,uuid,text,text,text,bigint,date,text)
  from public, anon, authenticated;

grant usage on schema ramagan_private to authenticated;
grant execute on function ramagan_private.create_product_impl(uuid,text,text,text,bigint)
  to authenticated;
grant execute on function public.ramagan_create_product(uuid,text,text,text,bigint)
  to authenticated;
grant execute on function ramagan_private.receive_lot_impl(uuid,uuid,text,text,text,bigint,date,text)
  to authenticated;
grant execute on function public.ramagan_receive_lot(uuid,uuid,text,text,text,bigint,date,text)
  to authenticated;

-- Release gates: staff denied, cross-store denied, unknown product denied,
-- repeated lot code denied; all-or-nothing stock/event insertion verified.
