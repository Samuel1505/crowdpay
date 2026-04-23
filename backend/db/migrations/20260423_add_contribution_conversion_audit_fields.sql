BEGIN;

ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'payment'
    CHECK (payment_type IN ('payment', 'path_payment_strict_receive')),
  ADD COLUMN IF NOT EXISTS source_amount NUMERIC(20, 7),
  ADD COLUMN IF NOT EXISTS source_asset TEXT,
  ADD COLUMN IF NOT EXISTS conversion_rate NUMERIC(30, 15),
  ADD COLUMN IF NOT EXISTS path JSONB;

COMMIT;
