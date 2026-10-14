-- Extra materials a partner buys while an article is being cut or stitched, with the supplier bill. Separate from the customer's own
-- prices; the admin approves each item and approved ones are added to the invoice once. Safe to run more than once.
CREATE TABLE IF NOT EXISTS public.order_extra_costs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  unit_id UUID REFERENCES public.order_units(id) ON DELETE SET NULL,
  partner_id UUID REFERENCES public.partners(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('cutting', 'stitching')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
  quantity NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  total_pkr NUMERIC(12, 2) NOT NULL CHECK (total_pkr >= 0),
  notes TEXT,
  -- the supplier bill: { path, name, type, size } in the private "documents" bucket
  bill JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_note TEXT,
  decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  -- lets the browser repeat a submit without making a second entry
  client_key TEXT,
  added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS order_extra_costs_order_idx ON public.order_extra_costs (order_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS order_extra_costs_client_key_idx ON public.order_extra_costs (order_id, client_key) WHERE client_key IS NOT NULL;

-- an invoice line that comes from an extra item: one item is on at most one invoice line, so a regenerated invoice never counts it twice
ALTER TABLE public.invoice_lines ADD COLUMN IF NOT EXISTS extra_cost_id UUID REFERENCES public.order_extra_costs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_lines_extra_cost_idx ON public.invoice_lines (extra_cost_id) WHERE extra_cost_id IS NOT NULL;

ALTER TABLE public.order_extra_costs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_extra_costs_staff" ON public.order_extra_costs;
CREATE POLICY "order_extra_costs_staff" ON public.order_extra_costs FOR ALL USING (public.staff_can_see_order(order_id)) WITH CHECK (public.staff_can_see_order(order_id));
NOTIFY pgrst, 'reload schema';
