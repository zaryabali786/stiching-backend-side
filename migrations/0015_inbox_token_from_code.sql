-- Every customer's shopping address now follows their customer code (STX-10011 -> stx-10011@<mail domain>).
-- Existing customers get the same, replacing their old random token.
UPDATE public.profiles
SET inbound_email_token = lower(customer_code)
WHERE customer_code IS NOT NULL
  AND inbound_email_token IS DISTINCT FROM lower(customer_code);
