-- Article weight, entered in Receiving. The invoice's shipping weight is the sum of the weights of the articles it covers.
alter table public.order_units add column if not exists weight_kg numeric(7,3);
do $$ begin
  alter table public.order_units add constraint order_units_weight_kg_check check (weight_kg is null or (weight_kg > 0 and weight_kg < 50));
exception when duplicate_object then null; end $$;
