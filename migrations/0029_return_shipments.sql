-- ==============================================================================
-- 0029_return_shipments.sql
-- The courier workflow of a returned article:
--   Return Requested -> CN booked (Ready for Return) -> loadsheet downloaded = Handed Over to Courier
--   -> In transit -> Delivered to customer -> Returned
-- One return shipment per returned article (never shared between articles), its tracking events, and the loadsheets that
-- hand a batch of parcels to one courier. Safe to run more than once.
-- ==============================================================================

-- an article whose return was delivered
alter table public.order_units drop constraint if exists order_units_return_status_check;
alter table public.order_units add constraint order_units_return_status_check
  check (return_status in ('none', 'requested', 'sent_back', 'resubmitted', 'held', 'returned'));

create sequence if not exists return_loadsheet_seq start with 1001;

create table if not exists public.return_loadsheets (
  id uuid primary key default uuid_generate_v4(),
  number text unique,
  partner_id uuid references public.partners(id) on delete set null,
  courier_id uuid references public.couriers(id) on delete set null,
  courier_name text,
  -- generated: the file was made · handed_over: it was downloaded and the parcels were handed over · void: replaced
  status text not null default 'generated' check (status in ('generated', 'handed_over', 'void')),
  -- what the loadsheet lists, as it was when it was made: [{ order, article, code, cn, to, name, phone, address, city }]
  items jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  handed_over_at timestamptz
);

create or replace function public.generate_return_loadsheet_number()
returns trigger as $$
begin
  if new.number is null then
    new.number := 'LS-' || nextval('return_loadsheet_seq')::text;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_return_loadsheet_number on public.return_loadsheets;
create trigger trg_return_loadsheet_number before insert on public.return_loadsheets
  for each row execute function public.generate_return_loadsheet_number();

create table if not exists public.return_shipments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.orders(id) on delete cascade,
  unit_id uuid not null references public.order_units(id) on delete cascade,
  partner_id uuid references public.partners(id) on delete set null,
  courier_id uuid references public.couriers(id) on delete set null,
  courier_name text not null,
  cn_number text not null check (char_length(btrim(cn_number)) between 4 and 40),
  status text not null default 'booked' check (status in ('booked', 'handed_over', 'in_transit', 'delivered', 'cancelled')),
  -- manual: the partner booked it with the courier and typed the CN here · api: booked through a courier API
  booking_source text not null default 'manual' check (booking_source in ('manual', 'api')),
  booking_response jsonb,
  return_to text,
  ship_to jsonb,
  loadsheet_id uuid references public.return_loadsheets(id) on delete set null,
  booked_by uuid references public.profiles(id) on delete set null,
  booked_at timestamptz not null default now(),
  handed_over_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- an article has at most one live return shipment, and a CN belongs to one live shipment of its courier
create unique index if not exists return_shipments_one_live_per_unit_idx on public.return_shipments (unit_id) where status <> 'cancelled';
create unique index if not exists return_shipments_cn_idx on public.return_shipments (courier_id, lower(btrim(cn_number))) where status <> 'cancelled';
create index if not exists return_shipments_order_idx on public.return_shipments (order_id);
create index if not exists return_shipments_partner_status_idx on public.return_shipments (partner_id, status);

create table if not exists public.return_shipment_events (
  id uuid primary key default uuid_generate_v4(),
  shipment_id uuid not null references public.return_shipments(id) on delete cascade,
  status text not null,
  note text,
  -- manual: typed by a person · webhook: sent by the courier · system: a step of our own workflow
  source text not null default 'system' check (source in ('manual', 'webhook', 'system')),
  -- the courier's id of this tracking event: a repeated delivery of the same event is stored once
  event_id text,
  occurred_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists return_shipment_events_dedupe_idx on public.return_shipment_events (shipment_id, event_id) where event_id is not null;
create index if not exists return_shipment_events_shipment_idx on public.return_shipment_events (shipment_id, occurred_at);

alter table public.return_loadsheets enable row level security;
alter table public.return_shipments enable row level security;
alter table public.return_shipment_events enable row level security;

drop policy if exists "return_shipments_staff" on public.return_shipments;
create policy "return_shipments_staff" on public.return_shipments for all using (public.staff_can_see_order(order_id)) with check (public.staff_can_see_order(order_id));
drop policy if exists "return_shipments_own_select" on public.return_shipments;
create policy "return_shipments_own_select" on public.return_shipments for select using (
  exists (select 1 from public.orders o where o.id = return_shipments.order_id and o.customer_id = auth.uid())
);
drop policy if exists "return_shipment_events_staff" on public.return_shipment_events;
create policy "return_shipment_events_staff" on public.return_shipment_events for all
  using (exists (select 1 from public.return_shipments s where s.id = return_shipment_events.shipment_id and public.staff_can_see_order(s.order_id)))
  with check (exists (select 1 from public.return_shipments s where s.id = return_shipment_events.shipment_id and public.staff_can_see_order(s.order_id)));
drop policy if exists "return_shipment_events_own_select" on public.return_shipment_events;
create policy "return_shipment_events_own_select" on public.return_shipment_events for select using (
  exists (select 1 from public.return_shipments s join public.orders o on o.id = s.order_id where s.id = return_shipment_events.shipment_id and o.customer_id = auth.uid())
);
drop policy if exists "return_loadsheets_admin" on public.return_loadsheets;
create policy "return_loadsheets_admin" on public.return_loadsheets for all using (public.is_admin()) with check (public.is_admin());

notify pgrst, 'reload schema';
