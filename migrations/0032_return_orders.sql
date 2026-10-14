-- ==============================================================================
-- 0032_return_orders.sql
-- A rejected article that goes back to the customer travels through the SAME Warehouse workflow as every outgoing parcel.
-- It becomes a "return order" (orders.order_kind = 'return') linked to the article (return_unit_id): invoice (return shipping),
-- payment, courier booking, loadsheet, dispatch and delivery all work on it as on any order. The partner chooses its destination:
--   customer  Return Directly to Customer: Waiting for invoice > Awaiting payment > Paid > courier ... > Delivered
--   admin     Send to Admin: added to the partner's transfer to the admin warehouse (no invoice), the admin ships it on
-- The article itself is never copied: the return order only points at it. Safe to run more than once.
-- ==============================================================================

alter table public.orders add column if not exists order_kind text not null default 'order';
alter table public.orders drop constraint if exists orders_order_kind_check;
alter table public.orders add constraint orders_order_kind_check check (order_kind in ('order', 'return'));
alter table public.orders add column if not exists return_unit_id uuid references public.order_units(id) on delete set null;
alter table public.orders add column if not exists return_destination text;
alter table public.orders drop constraint if exists orders_return_destination_check;
alter table public.orders add constraint orders_return_destination_check check (return_destination is null or return_destination in ('customer', 'admin'));

-- one live return order per article
create unique index if not exists orders_one_live_return_per_unit_idx on public.orders (return_unit_id) where return_unit_id is not null and status <> 'cancelled';
create index if not exists orders_kind_idx on public.orders (order_kind) where order_kind <> 'order';

notify pgrst, 'reload schema';
