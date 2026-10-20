-- Additive worker cutover. Do not remove legacy enqueue/claim entrypoints until
-- the dedicated workers have been deployed and their leases verified.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_sync_checkpoints (
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id),
  xero_connection_id uuid NOT NULL,
  source_sync_at timestamptz NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, xero_connection_id),
  FOREIGN KEY(xero_connection_id,customer_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.xero_connections(xero_connection_id,customer_id)
);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_sync_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_sync_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_sync_checkpoints
  USING (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid)
  WITH CHECK (customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid);
-- Runtime only reads the checkpoint. The existing identity-side worker commits
-- it with its authorized scan/apply transaction; no cross-schema grants added.
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_sync_checkpoints TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.student_operations_automatic_window(at_time timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path=pg_catalog
AS $$ SELECT EXTRACT(HOUR FROM at_time AT TIME ZONE 'Australia/Brisbane') >= 1
        AND EXTRACT(HOUR FROM at_time AT TIME ZONE 'Australia/Brisbane') < 6 $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.student_operations_automatic_window(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.student_operations_automatic_window(timestamptz) TO sophia_runtime_app;

CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_worker_runs(requested_limit integer DEFAULT 1)
RETURNS TABLE(customer_id uuid, sync_run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,__SOPHIA_RUNTIME_SCHEMA__
AS $$
DECLARE automatic_window boolean := student_operations_automatic_window();
BEGIN
  -- Locks, the partial unique active-run index and the processing lease make
  -- duplicate worker invocations safe. Only active configured tenants qualify.
  IF automatic_window THEN
    -- A daytime webhook may already occupy the active-run slot. Upgrade it to
    -- a full scan when due so webhooks cannot starve periodic reconciliation.
    UPDATE student_operations_xero_sync_runs r SET
      mode=CASE WHEN c.last_successful_sync_at IS NULL THEN 'initial' ELSE 'reconciliation' END,
      modified_since=NULL
    FROM student_operations_xero_sync_configurations c
    WHERE r.customer_id=c.customer_id AND r.xero_connection_id=c.xero_connection_id
      AND c.enabled AND c.organisation_role='trust' AND r.status='queued' AND r.trigger_type<>'manual'
      AND (c.last_successful_sync_at IS NULL OR c.last_reconciliation_sync_at IS NULL
        OR c.last_reconciliation_sync_at<now()-c.reconciliation_interval);
    INSERT INTO student_operations_xero_sync_runs
      (customer_id,xero_connection_id,mode,trigger_type,modified_since)
    SELECT c.customer_id,c.xero_connection_id,
      CASE WHEN c.last_successful_sync_at IS NULL THEN 'initial'
        WHEN c.last_reconciliation_sync_at IS NULL OR c.last_reconciliation_sync_at<now()-c.reconciliation_interval
          THEN 'reconciliation' ELSE 'incremental' END,
      'schedule',
      CASE WHEN c.last_successful_sync_at IS NOT NULL AND c.last_reconciliation_sync_at IS NOT NULL
        AND c.last_reconciliation_sync_at>=now()-c.reconciliation_interval
        THEN c.last_successful_sync_at-interval '5 minutes' ELSE NULL END
    FROM student_operations_xero_sync_configurations c
    JOIN customers tenant ON tenant.customer_id=c.customer_id AND tenant.status='active'
    JOIN xero_connections connection ON connection.customer_id=c.customer_id
      AND connection.xero_connection_id=c.xero_connection_id AND connection.status IN ('active','degraded')
    WHERE c.enabled AND c.organisation_role='trust' AND c.next_sync_at<=now()
      AND NOT EXISTS (SELECT 1 FROM student_operations_xero_sync_runs r
        WHERE r.customer_id=c.customer_id AND r.xero_connection_id=c.xero_connection_id
          AND r.status IN ('queued','processing'))
    ORDER BY c.next_sync_at,c.customer_id
    LIMIT greatest(1,least(requested_limit,10))
    FOR UPDATE OF c SKIP LOCKED
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY SELECT r.customer_id,r.sync_run_id FROM student_operations_xero_sync_runs r
    JOIN student_operations_xero_sync_configurations c USING(customer_id,xero_connection_id)
    JOIN customers tenant ON tenant.customer_id=r.customer_id AND tenant.status='active'
    JOIN xero_connections connection ON connection.customer_id=r.customer_id
      AND connection.xero_connection_id=r.xero_connection_id AND connection.status IN ('active','degraded')
    WHERE c.enabled AND c.organisation_role='trust'
      AND (r.status='queued' OR (r.status='processing' AND r.lease_expires_at<now()))
      AND (r.trigger_type='manual' OR automatic_window)
    ORDER BY (r.trigger_type='manual') DESC,r.created_at,r.sync_run_id
    LIMIT greatest(1,least(requested_limit,10));
END;
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_worker_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.claim_due_student_operations_xero_worker_runs(integer) TO sophia_runtime_app;
