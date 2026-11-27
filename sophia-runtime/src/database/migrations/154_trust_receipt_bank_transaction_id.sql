ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  ADD COLUMN bank_transaction_id text CHECK (length(bank_transaction_id) BETWEEN 1 AND 150);

CREATE UNIQUE INDEX student_trust_receipt_bank_transaction ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  (customer_id, connection_id, lower(account_label), bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

-- A receipt without a bank ID cannot distinguish otherwise identical movements.
-- Serialise inserts on the invoice so concurrent identified and unidentified receipts
-- see each other under the runtime's READ COMMITTED transaction.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.guard_trust_receipt_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.invoice_id::text, 154));
  IF EXISTS (
    SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications r
    WHERE r.customer_id=NEW.customer_id AND r.connection_id=NEW.connection_id AND r.invoice_id=NEW.invoice_id
      AND r.received_on=NEW.received_on AND r.amount=NEW.amount
      AND lower(r.account_label)=lower(NEW.account_label) AND lower(r.reference)=lower(NEW.reference)
      AND (r.bank_transaction_id IS NULL OR NEW.bank_transaction_id IS NULL)
  ) THEN RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_trust_receipt_identity BEFORE INSERT ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.guard_trust_receipt_identity();

CREATE INDEX student_trust_receipt_identity_lookup ON __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipt_verifications
  (customer_id,connection_id,invoice_id,received_on,amount,lower(account_label),lower(reference));
DROP INDEX __SOPHIA_RUNTIME_SCHEMA__.student_trust_receipts_repeat;
