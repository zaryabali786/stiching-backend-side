-- ==============================================================================
-- 0030_dispatch_shipments.sql
-- Direct dispatch from the partner warehouse, with the same courier / loadsheet logic as the returns:
--   Paid -> CN booked (Ready for dispatch) -> loadsheet downloaded -> handover confirmed (Dispatched)
--   -> In transit -> Delivered   |   failed delivery -> returning to the partner -> received back
-- Extends the existing shipments table (one per order) and the loadsheet table of the returns. Safe to run more than once.
-- ==============================================================================

alter table public.shipments drop constraint if exists shipments_status_check;
alter table public.shipments add constraint shipments_status_check check (status in (
  'needs_label',          -- paid, no courier booked yet
  'booked',               -- CN saved: ready for dispatch
  'labelled',             -- loadsheet downloaded, waiting for the courier to take the parcels
  'handed_to_courier',    -- handover confirmed: dispatched
  'in_transit',
  'delivered',
  'failed_delivery',      -- an attempt failed (the courier may try again)
  'returning_to_partner', -- the courier confirmed the parcel is coming back
  'returned_to_partner'   -- the partner confirmed it is physically back
));

alter table public.shipments add column if not exists courier_id uuid references public.couriers(id) on delete set null;
-- manual: the partner booked with the courier and typed the CN · api: booked through a courier API
alter table public.shipments add column if not exists booking_source text not null default 'manual';
alter table public.shipments add column if not exists booking_response jsonb;
alter table public.shipments add column if not exists booked_at timestamptz;
alter table public.shipments add column if not exists booked_by uuid references public.profiles(id) on delete set null;
alter table public.shipments add column if not exists loadsheet_id uuid references public.return_loadsheets(id) on delete set null;
alter table public.shipments add column if not exists failure_reason text;
alter table public.shipments add column if not exists failed_at timestamptz;
alter table public.shipments add column if not exists return_started_at timestamptz;
alter table public.shipments add column if not exists returned_at timestamptz;
alter table public.shipments add column if not exists returned_confirmed_by uuid references public.profiles(id) on delete set null;
-- proof of delivery when the courier sends it: { receiver, note, url }
alter table public.shipments add column if not exists proof jsonb;

-- a CN belongs to one live shipment of its courier
create unique index if not exists shipments_courier_cn_idx on public.shipments (courier_id, lower(btrim(tracking_number))) where tracking_number is not null and courier_id is not null;

-- loadsheets are shared with the returns
alter table public.return_loadsheets add column if not exists kind text not null default 'return';
alter table public.return_loadsheets drop constraint if exists return_loadsheets_kind_check;
alter table public.return_loadsheets add constraint return_loadsheets_kind_check check (kind in ('return', 'dispatch'));
alter table public.return_loadsheets drop constraint if exists return_loadsheets_status_check;
alter table public.return_loadsheets add constraint return_loadsheets_status_check check (status in ('generated', 'downloaded', 'handed_over', 'void'));

create table if not exists public.shipment_events (
  id uuid primary key default uuid_generate_v4(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status text not null,
  note text,
  source text not null default 'system' check (source in ('manual', 'webhook', 'system')),
  event_id text,
  occurred_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists shipment_events_dedupe_idx on public.shipment_events (shipment_id, event_id) where event_id is not null;
create index if not exists shipment_events_shipment_idx on public.shipment_events (shipment_id, occurred_at);

alter table public.shipment_events enable row level security;
drop policy if exists "shipment_events_staff" on public.shipment_events;
create policy "shipment_events_staff" on public.shipment_events for all
  using (exists (select 1 from public.shipments s where s.id = shipment_events.shipment_id and public.staff_can_see_order(s.order_id)))
  with check (exists (select 1 from public.shipments s where s.id = shipment_events.shipment_id and public.staff_can_see_order(s.order_id)));
drop policy if exists "shipment_events_own_select" on public.shipment_events;
create policy "shipment_events_own_select" on public.shipment_events for select using (
  exists (select 1 from public.shipments s join public.orders o on o.id = s.order_id where s.id = shipment_events.shipment_id and o.customer_id = auth.uid())
);

notify pgrst, 'reload schema';
