-- RAMAGAN V1 TEST SCHEMA — review/audit before execution in a dedicated Supabase project.
-- DO NOT run against a production database without backup and change approval.
-- Requires Supabase Auth (auth.users, auth.uid()) and PostgreSQL.
-- All client DML is revoked: inventory writes MUST pass through protected RPCs.
-- LIVE checkout disabled by default (ramagan_stores.sales_enabled = false).

create extension if not exists pgcrypto;
create schema if not exists ramagan_private;
revoke all on schema ramagan_private from public, anon;

create table public.ramagan_stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  sales_enabled boolean not null default false,
  requires_authorization boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.ramagan_members (
  store_id uuid not null references public.ramagan_stores(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('owner', 'manager', 'staff')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create table public.ramagan_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.ramagan_stores(id) on delete restrict,
  sku text not null check (length(trim(sku)) between 1 and 60),
  name text not null check (length(trim(name)) between 1 and 200),
  category text not null default 'other',
  price_satang_per_gram bigint not null check (price_satang_per_gram >= 0 and price_satang_per_gram <= 100000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, sku),
  unique (id, store_id)
);

create table public.ramagan_lots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.ramagan_stores(id) on delete restrict,
  product_id uuid not null,
  lot_code text not null check (length(trim(lot_code)) between 1 and 100),
  supplier_name text not null check (length(trim(supplier_name)) between 1 and 200),
  supplier_document_ref text not null check (length(trim(supplier_document_ref)) between 1 and 200),
  expires_on date,
  active boolean not null default true,
  received_at timestamptz not null default now(),
  foreign key (product_id, store_id) references public.ramagan_products(id, store_id) on delete restrict,
  unique (store_id, lot_code)
);

create table public.ramagan_lot_balances (
  lot_id uuid primary key references public.ramagan_lots(id) on delete restrict,
  quantity_mg bigint not null default 0 check (quantity_mg >= 0),
  updated_at timestamptz not null default now()
);

create table public.ramagan_sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.ramagan_stores(id) on delete restrict,
  client_sale_id uuid not null,
  cashier_user_id uuid not null references auth.users(id) on delete restrict,
  payment_method text not null check (payment_method in ('cash', 'transfer')),
  authorization_ref text,
  subtotal_satang bigint not null default 0 check (subtotal_satang >= 0),
  total_satang bigint not null default 0 check (total_satang >= 0),
  status text not null default 'completed' check (status in ('completed')),
  created_at timestamptz not null default now(),
  unique (store_id, client_sale_id)
);

create table public.ramagan_sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.ramagan_sales(id) on delete restrict,
  lot_id uuid not null references public.ramagan_lots(id) on delete restrict,
  quantity_mg bigint not null check (quantity_mg > 0),
  unit_price_satang_per_gram bigint not null check (unit_price_satang_per_gram >= 0),
  line_total_satang bigint not null check (line_total_satang >= 0),
  unique (sale_id, lot_id)
);

create table public.ramagan_ledger_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.ramagan_stores(id) on delete restrict,
  lot_id uuid not null references public.ramagan_lots(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null check (event_type in (
    'RECEIVE', 'SALE', 'ADJUST', 'DESTROY', 'TRANSFER_IN', 'TRANSFER_OUT'
  )),
  quantity_delta_mg bigint not null check (quantity_delta_mg <> 0),
  reason text not null check (length(trim(reason)) between 1 and 500),
  sale_id uuid references public.ramagan_sales(id) on delete restrict,
  client_event_id uuid,
  created_at timestamptz not null default now(),
  unique (store_id, client_event_id)
);
create index ramagan_ledger_store_lot_idx on public.ramagan_ledger_events(store_id, lot_id, created_at);
create index ramagan_sales_store_date_idx on public.ramagan_sales(store_id, created_at);

-- RLS on EVERY table exposed through public. No direct client writes.
alter table public.ramagan_stores enable row level security;
alter table public.ramagan_members enable row level security;
alter table public.ramagan_products enable row level security;
alter table public.ramagan_lots enable row level security;
alter table public.ramagan_lot_balances enable row level security;
alter table public.ramagan_sales enable row level security;
alter table public.ramagan_sale_lines enable row level security;
alter table public.ramagan_ledger_events enable row level security;

revoke all on public.ramagan_stores, public.ramagan_members,
 public.ramagan_products, public.ramagan_lots, public.ramagan_lot_balances,
 public.ramagan_sales, public.ramagan_sale_lines, public.ramagan_ledger_events
 from public, anon, authenticated;
grant select on public.ramagan_stores, public.ramagan_members,
 public.ramagan_products, public.ramagan_lots, public.ramagan_lot_balances,
 public.ramagan_sales, public.ramagan_sale_lines, public.ramagan_ledger_events
 to authenticated;

create policy "member can see own membership" on public.ramagan_members
 for select to authenticated using (user_id = (select auth.uid()));

create policy "member can see own store" on public.ramagan_stores
 for select to authenticated using (exists (
   select 1 from public.ramagan_members m
   where m.store_id = id and m.user_id = (select auth.uid()) and m.is_active
 ));

create policy "member can see products" on public.ramagan_products
 for select to authenticated using (exists (
   select 1 from public.ramagan_members m
   where m.store_id = public.ramagan_products.store_id and m.user_id = (select auth.uid()) and m.is_active
 ));

create policy "member can see lots" on public.ramagan_lots
 for select to authenticated using (exists (
   select 1 from public.ramagan_members m
   where m.store_id = public.ramagan_lots.store_id and m.user_id = (select auth.uid()) and m.is_active
 ));

create policy "member can see balances" on public.ramagan_lot_balances
 for select to authenticated using (exists (
   select 1 from public.ramagan_lots l
   join public.ramagan_members m on m.store_id = l.store_id
   where l.id = lot_id and m.user_id = (select auth.uid()) and m.is_active
 ));

create policy "role scoped sale visibility" on public.ramagan_sales
 for select to authenticated using (exists (
   select 1 from public.ramagan_members m
   where m.store_id = public.ramagan_sales.store_id and m.user_id = (select auth.uid())
     and m.is_active and (m.role in ('owner','manager') or cashier_user_id = (select auth.uid()))
 ));

create policy "role scoped sale lines" on public.ramagan_sale_lines
 for select to authenticated using (exists (
   select 1 from public.ramagan_sales s where s.id = sale_id
 ));

create policy "managers can read ledger" on public.ramagan_ledger_events
 for select to authenticated using (exists (
   select 1 from public.ramagan_members m
   where m.store_id = public.ramagan_ledger_events.store_id and m.user_id = (select auth.uid())
     and m.is_active and m.role in ('owner','manager')
 ));

-- SECURITY DEFINER is deliberately limited to this NON-EXPOSED schema,
-- with explicit auth.uid(), membership, store and stock checks.
create or replace function ramagan_private.checkout_impl(
  p_store_id uuid, p_client_sale_id uuid, p_items jsonb,
  p_payment_method text, p_authorization_ref text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_sales_enabled boolean;
  v_requires_authorization boolean;
  v_sale_id uuid;
  v_old_total bigint;
  v_total bigint := 0;
  v_line jsonb;
  v_lot_id uuid;
  v_last_lot uuid;
  v_quantity bigint;
  v_available bigint;
  v_price bigint;
  v_expires date;
  v_line_total bigint;
  v_line_id uuid;
begin
  if v_actor is null or p_client_sale_id is null or p_store_id is null then
    raise exception 'Authentication and store are required' using errcode = '42501';
  end if;

  select role into v_role from public.ramagan_members
    where store_id = p_store_id and user_id = v_actor and is_active;
  if v_role is null then
    raise exception 'Not authorized for this store' using errcode = '42501';
  end if;

  -- Idempotency: already committed sale -> return exactly the same sale.
  select id, total_satang into v_sale_id, v_old_total
    from public.ramagan_sales where store_id = p_store_id
    and client_sale_id = p_client_sale_id;
  if found then
    return jsonb_build_object('sale_id', v_sale_id, 'total_satang', v_old_total, 'duplicate', true);
  end if;

  select sales_enabled, requires_authorization into v_sales_enabled, v_requires_authorization
    from public.ramagan_stores where id = p_store_id;
  if not found or not v_sales_enabled then
    raise exception 'Sales are not activated for this store' using errcode = '42501';
  end if;
  if v_requires_authorization and length(trim(coalesce(p_authorization_ref, ''))) = 0 then
    raise exception 'Authorized document reference is required' using errcode = '22023';
  end if;
  if length(coalesce(p_authorization_ref, '')) > 120 then
    raise exception 'Document reference is too long' using errcode = '22023';
  end if;
  if p_payment_method not in ('cash', 'transfer') or p_payment_method is null then
    raise exception 'Unsupported payment method' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Items must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'Items must have 1 to 50 lines' using errcode = '22023';
  end if;

  insert into public.ramagan_sales(
    store_id, client_sale_id, cashier_user_id,
    payment_method, authorization_ref, subtotal_satang, total_satang
  ) values (
    p_store_id, p_client_sale_id, v_actor,
    p_payment_method, nullif(trim(p_authorization_ref), ''), 0, 0
  )
  on conflict (store_id, client_sale_id) do nothing
  returning id into v_sale_id;

  -- Handles concurrent retry of the same client UUID.
  if v_sale_id is null then
    select id, total_satang into v_sale_id, v_old_total
      from public.ramagan_sales where store_id = p_store_id
      and client_sale_id = p_client_sale_id;
    if v_sale_id is null then
      raise exception 'Unable to resolve duplicate checkout, retry with same UUID';
    end if;
    return jsonb_build_object('sale_id', v_sale_id, 'total_satang', v_old_total, 'duplicate', true);
  end if;

  -- Deterministic lot order avoids deadlocks between multi-line checkouts.
  for v_line in
    select value from jsonb_array_elements(p_items) as x(value)
      order by (value->>'lot_id')::uuid
  loop
    if jsonb_typeof(v_line) <> 'object' or
      v_line->>'lot_id' is null or v_line->>'quantity_mg' is null then
      raise exception 'Missing lot_id or quantity_mg' using errcode = '22023';
    end if;
    v_lot_id := (v_line->>'lot_id')::uuid;
    v_quantity := (v_line->>'quantity_mg')::bigint;
    if v_quantity <= 0 or v_quantity > 1000000 then
      raise exception 'Invalid quantity' using errcode = '22023';
    end if;
    if v_last_lot = v_lot_id then
      raise exception 'Duplicate lot in one checkout' using errcode = '22023';
    end if;
    v_last_lot := v_lot_id;

    select b.quantity_mg, p.price_satang_per_gram, l.expires_on
      into v_available, v_price, v_expires
      from public.ramagan_lots l
      join public.ramagan_products p on p.id = l.product_id and p.store_id = l.store_id
      join public.ramagan_lot_balances b on b.lot_id = l.id
      where l.id = v_lot_id and l.store_id = p_store_id
        and l.active and p.active
      for update of b;
    if not found then
      raise exception 'Unknown or inactive lot: %', v_lot_id;
    end if;
    if v_expires is not null and v_expires < (now() at time zone 'Asia/Bangkok')::date then
      raise exception 'Expired lot: %', v_lot_id;
    end if;
    if v_quantity > v_available then
      raise exception 'Insufficient stock for lot: %', v_lot_id;
    end if;

    -- Exact integer satang rounding; never trust the client-supplied price.
    v_line_total := (v_price * v_quantity + 500) / 1000;
    v_total := v_total + v_line_total;

    update public.ramagan_lot_balances
      set quantity_mg = quantity_mg - v_quantity, updated_at = now()
      where lot_id = v_lot_id and quantity_mg >= v_quantity;
    if not found then
      raise exception 'Concurrent stock change for lot: %', v_lot_id;
    end if;

    insert into public.ramagan_sale_lines(
      sale_id, lot_id, quantity_mg, unit_price_satang_per_gram, line_total_satang
    ) values (
      v_sale_id, v_lot_id, v_quantity, v_price, v_line_total
    ) returning id into v_line_id;

    insert into public.ramagan_ledger_events(
      store_id, lot_id, actor_user_id, event_type,
      quantity_delta_mg, reason, sale_id
    ) values (
      p_store_id, v_lot_id, v_actor, 'SALE',
      -v_quantity, 'checkout line ' || v_line_id::text, v_sale_id
    );
  end loop;

  update public.ramagan_sales set subtotal_satang = v_total, total_satang = v_total
    where id = v_sale_id;
  return jsonb_build_object('sale_id', v_sale_id, 'total_satang', v_total, 'duplicate', false);
end
$$;

-- Public RPC is SECURITY INVOKER; it delegates to the checked private function.
create or replace function public.ramagan_checkout(
  p_store_id uuid, p_client_sale_id uuid, p_items jsonb,
  p_payment_method text, p_authorization_ref text
) returns jsonb
language sql security invoker set search_path = ''
as $$
  select ramagan_private.checkout_impl(
    p_store_id, p_client_sale_id, p_items, p_payment_method, p_authorization_ref
  );
$$;

revoke all on function public.ramagan_checkout(uuid,uuid,jsonb,text,text) from public, anon, authenticated;
revoke all on function ramagan_private.checkout_impl(uuid,uuid,jsonb,text,text) from public, anon, authenticated;
grant usage on schema ramagan_private to authenticated;
grant execute on function ramagan_private.checkout_impl(uuid,uuid,jsonb,text,text) to authenticated;
grant execute on function public.ramagan_checkout(uuid,uuid,jsonb,text,text) to authenticated;

-- Bootstrap only via privileged administration after users are created:
-- INSERT INTO public.ramagan_stores (name) VALUES ('Licensed location') RETURNING id;
-- INSERT INTO public.ramagan_members(store_id,user_id,role)
--   VALUES ('<store-uuid>','<auth-user-uuid>','owner');
-- Always keep sales_enabled=false until legal review + QA signed off.
-- Production additionally needs audit of RLS, policy tests, backup restore,
-- inventory-receive RPC and reconciliation flows before activation.