-- Read-only preview for bm_merge_joselin_aburto_std_1069_into_std_398.sql.
SELECT u.student_id, u.id AS user_id, u.company_id, u.name, u.email,
       u.type, u.status
FROM public.users u
WHERE u.student_id IN ('STD-1069', 'STD-398')
ORDER BY u.student_id;

SELECT c.customer_id, c.connection_id, c.display_name, c.status,
       c.student_id, c.contact_ids, c.record_count,
       (SELECT count(*) FROM public.bm_xero_student_contact_links l
        WHERE l.customer_id = c.customer_id AND l.student_id = c.student_id
          AND l.connection_id = c.connection_id
          AND l.contact_id = ANY(c.contact_ids)) AS contact_links,
       (SELECT count(*) FROM sophia_runtime.student_operations_xero_invoices i
        WHERE i.customer_id = c.customer_id AND i.student_id = c.student_id
          AND i.xero_connection_id = c.connection_id
          AND i.xero_contact_id = ANY(c.contact_ids)) AS invoices
FROM public.bm_xero_student_sync_candidates c
WHERE c.student_id IN ('STD-1069', 'STD-398')
ORDER BY c.student_id, c.display_name;

SELECT r.customer_id, r.mode, r.status, r.phase
FROM public.bm_xero_student_sync_runs r
WHERE r.status IN ('queued', 'processing')
  AND r.customer_id IN (
    SELECT customer_id FROM public.bm_xero_student_sync_candidates
    WHERE student_id IN ('STD-1069', 'STD-398')
  );
