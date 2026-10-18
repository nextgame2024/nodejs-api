-- Business advisor identities are distinct from advisor login accounts and
-- case access grants. The Xero label is retained for audit and exact matching.
CREATE TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory (
  advisor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers(customer_id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 30),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  xero_label text NOT NULL CHECK (length(btrim(xero_label)) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, advisor_id),
  UNIQUE (customer_id, code),
  UNIQUE (customer_id, xero_label)
);
CREATE INDEX student_operations_advisor_directory_name
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory(customer_id, lower(name), advisor_id);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY student_operations_advisor_directory_tenant_isolation
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory
  USING (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid)
  WITH CHECK (customer_id = NULLIF(current_setting('sophia.tenant_id', true), '')::uuid);
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory TO sophia_runtime_app;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  ADD COLUMN advisor_id uuid;
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students
  ADD CONSTRAINT student_operations_students_advisor_fk
  FOREIGN KEY (customer_id, advisor_id)
  REFERENCES __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory(customer_id, advisor_id)
  ON DELETE RESTRICT;
CREATE INDEX student_operations_students_advisor
  ON __SOPHIA_RUNTIME_SCHEMA__.student_operations_students(customer_id, advisor_id);

-- These are the 18 data rows from the supplied advisor.csv. Scope the seed to
-- the Open for Australia company; never install its advisors in other tenants.
INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory
  (customer_id, xero_label, code, name)
SELECT c.customer_id, source.xero_label, source.code, source.name
  FROM __SOPHIA_RUNTIME_SCHEMA__.customers c
  CROSS JOIN (VALUES
    ('Pedro Muñoz', 'C01', 'Pedro Muñoz'),
    ('S15 Paulina Aguillon', 'S15', 'Paulina Aguillon'),
    ('C90 Yuliet Chica', 'C90', 'Yuliet Chica'),
    ('C70 Angela White', 'C70', 'Angela White'),
    ('C81 Juan Jose Giraldo', 'C81', 'Juan Jose Giraldo'),
    ('S10 Julieta Mesa', 'S10', 'Julieta Mesa'),
    ('S11 Andres Hernandez', 'S11', 'Andres Hernandez'),
    ('O10 Open for Australia', 'O10', 'Open for Australia'),
    ('C31 Liliana Gallego', 'C31', 'Liliana Gallego'),
    ('C30 Pablo Arias', 'C30', 'Pablo Arias'),
    ('C10 Santiago Ocampo', 'C10', 'Santiago Ocampo'),
    ('S80 Daniela Yepez', 'S80', 'Daniela Yepez'),
    ('C20 Rodrigo Galvis', 'C20', 'Rodrigo Galvis'),
    ('C82 Cindy Ortiz', 'C82', 'Cindy Ortiz'),
    ('S30 Melisa Lopez', 'S30', 'Melisa Lopez'),
    ('C60 Hernan Sierra', 'C60', 'Hernan Sierra'),
    ('B21- Diana Romero', 'B21', 'Diana Romero'),
    ('C40 Carolina Gil', 'C40', 'Carolina Gil')
  ) AS source(xero_label, code, name)
 WHERE c.external_company_id = '80d5e42f-2de1-4792-86b5-54c7cdeb2660'
ON CONFLICT (customer_id, code) DO NOTHING;

-- Link existing profiles using the newest non-void Xero advisor value. No
-- fuzzy matches or manual assignments are overwritten.
WITH candidates AS (
  SELECT link.customer_id, link.student_id, i.advisor_name,
         i.invoice_date, i.xero_invoice_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_case_invoice_links link
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id = link.customer_id
     AND i.xero_connection_id = link.xero_connection_id
     AND i.xero_invoice_id = link.xero_invoice_id
   WHERE i.invoice_status NOT IN ('DELETED', 'VOIDED')
     AND nullif(btrim(i.advisor_name), '') IS NOT NULL
  UNION ALL
  SELECT l.customer_id, l.student_id, i.advisor_name,
         i.invoice_date, i.xero_invoice_id
    FROM __SOPHIA_RUNTIME_SCHEMA__.student_operations_student_user_links l
    JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_xero_invoices i
      ON i.customer_id = l.customer_id AND i.student_id = l.student_reference
   WHERE i.invoice_status NOT IN ('DELETED', 'VOIDED')
     AND nullif(btrim(i.advisor_name), '') IS NOT NULL
), latest AS (
  SELECT DISTINCT ON (customer_id, student_id)
         customer_id, student_id, advisor_name
    FROM candidates
   ORDER BY customer_id, student_id, invoice_date DESC NULLS LAST, xero_invoice_id DESC
)
UPDATE __SOPHIA_RUNTIME_SCHEMA__.student_operations_students student
   SET advisor_id = directory.advisor_id
  FROM latest
  JOIN __SOPHIA_RUNTIME_SCHEMA__.student_operations_advisor_directory directory
    ON directory.customer_id = latest.customer_id
   AND lower(regexp_replace(btrim(directory.xero_label), '[[:space:]]+', ' ', 'g')) =
       lower(regexp_replace(btrim(latest.advisor_name), '[[:space:]]+', ' ', 'g'))
 WHERE student.customer_id = latest.customer_id
   AND student.student_id = latest.student_id
   AND student.advisor_id IS NULL;
