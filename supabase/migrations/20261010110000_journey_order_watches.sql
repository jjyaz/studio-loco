-- Add native order observation to the existing private, lease/CAS-gated Signal Box.
-- No grants, policies, watch limits or signing capabilities change.
BEGIN;
ALTER TABLE public.signal_watches DROP CONSTRAINT signal_watches_kind_check;
ALTER TABLE public.signal_watches ADD CONSTRAINT signal_watches_kind_check CHECK (kind IN ('position', 'arb', 'order'));
COMMIT;
