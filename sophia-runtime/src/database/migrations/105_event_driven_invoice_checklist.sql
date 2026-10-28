-- Financial checks are cached until relevant source data changes. The existing
-- document expiry sweep remains, but does not repeat financial comparisons.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations
  ADD COLUMN invoice_dirty boolean NOT NULL DEFAULT true,
  ADD COLUMN invoice_result jsonb,
  ADD COLUMN invoice_checked_at timestamptz;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.invalidate_invoice_checklist()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='student_operations_xero_invoices' THEN
    IF TG_OP='UPDATE' AND ROW(NEW.xero_contact_id,NEW.invoice_type,NEW.invoice_status,NEW.invoice_date,NEW.due_date,NEW.currency_code,NEW.invoice_reference,NEW.total,NEW.payment_track,NEW.line_items)
      IS NOT DISTINCT FROM ROW(OLD.xero_contact_id,OLD.invoice_type,OLD.invoice_status,OLD.invoice_date,OLD.due_date,OLD.currency_code,OLD.invoice_reference,OLD.total,OLD.payment_track,OLD.line_items) THEN RETURN NEW; END IF;
    UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations v SET invoice_dirty=true
      WHERE v.customer_id=NEW.customer_id AND EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports e
        WHERE e.customer_id=NEW.customer_id AND e.xero_connection_id=NEW.xero_connection_id AND e.xero_invoice_id=NEW.xero_invoice_id AND e.case_id=v.case_id);
  ELSE
    IF TG_OP='UPDATE' THEN
      IF TG_TABLE_NAME='student_case_xero_invoice_exports' THEN
        IF ROW(NEW.status,NEW.xero_invoice_id) IS NOT DISTINCT FROM ROW(OLD.status,OLD.xero_invoice_id) THEN RETURN NEW; END IF;
      END IF;
    END IF;
    UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_document_checklist_evaluations SET invoice_dirty=true WHERE customer_id=NEW.customer_id AND case_id=NEW.case_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.invalidate_invoice_checklist() FROM PUBLIC;
CREATE TRIGGER invoice_checklist_changed AFTER INSERT OR UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.invalidate_invoice_checklist();
CREATE TRIGGER invoice_checklist_receipt_changed AFTER INSERT OR UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.student_case_xero_invoice_exports
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.invalidate_invoice_checklist();
CREATE TRIGGER invoice_checklist_draft_changed AFTER INSERT OR UPDATE OF snapshot ON __SOPHIA_RUNTIME_SCHEMA__.student_case_invoice_draft_batches
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.invalidate_invoice_checklist();
CREATE TRIGGER invoice_checklist_offer_changed AFTER INSERT OR UPDATE OF is_current,status ON __SOPHIA_RUNTIME_SCHEMA__.student_case_offers
  FOR EACH ROW EXECUTE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.invalidate_invoice_checklist();
