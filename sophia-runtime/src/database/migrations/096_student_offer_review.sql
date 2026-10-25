-- Reviewed financial projections are new immutable versions of the source result.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews ADD CONSTRAINT student_offer_review_scope
  UNIQUE(customer_id,case_id,document_id,result_id,review_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews ADD COLUMN review_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(review_context)='object');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offer_instalments ADD COLUMN components jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(components)='array');
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_case_offers
  DROP CONSTRAINT student_case_offers_customer_id_result_id_key,
  ADD COLUMN review_version integer NOT NULL DEFAULT 0 CHECK(review_version>=0),
  ADD COLUMN review_id uuid,
  ADD CONSTRAINT student_offer_result_version UNIQUE(customer_id,result_id,review_version),
  ADD CONSTRAINT student_offer_review_reference FOREIGN KEY(customer_id,case_id,document_id,result_id,review_id)
    REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_document_reviews(customer_id,case_id,document_id,result_id,review_id),
  ADD CONSTRAINT student_offer_review_state CHECK((review_version=0 AND review_id IS NULL) OR (review_version>0 AND review_id IS NOT NULL));
CREATE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_operations_offer_college_directory WITH(security_barrier=true) AS
SELECT c.customer_id,b.college_id,b.college_name,b.abn
FROM __SOPHIA_RUNTIME_SCHEMA__.customers c JOIN public.bm_colleges b ON b.company_id::text=c.external_company_id
WHERE c.status='active' AND b.status='active'
  AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_offer_college_directory FROM PUBLIC,sophia_runtime_app;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_offer_college_directory TO sophia_runtime_app;
-- Preserve source review attribution when a header is superseded.
CREATE INDEX student_offer_case_versions ON __SOPHIA_RUNTIME_SCHEMA__.student_case_offers(customer_id,case_id,created_at DESC,offer_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_write_requests DROP CONSTRAINT student_operations_write_requests_operation_check,
  ADD CONSTRAINT student_operations_write_requests_operation_check CHECK(operation IN
    ('student.create','student.update','case.create','case.create_student','case.update','case.link_invoice',
     'document_type.create','document_type.update','case.checklist.update','document.analysis.review','document.analysis.retry','document.analysis.start'));
