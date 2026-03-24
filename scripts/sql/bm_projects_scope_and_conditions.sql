-- Add scope and conditions to bm_projects.
ALTER TABLE bm_projects
  ADD COLUMN IF NOT EXISTS scope_and_conditions text;

UPDATE bm_projects
SET scope_and_conditions = $$Design Specification
Metallic epoxy design as approved via email, including agreed colour palette, description, and reference photos on previous quote. (sample board to be presented by photos before installation).

Terms
By accepting this invoice, the client confirms approval of the pre-installation guidelines, quotation, and Sunshine Resin's terms and conditions.$$
WHERE scope_and_conditions IS NULL;

ALTER TABLE bm_projects
  ALTER COLUMN scope_and_conditions SET DEFAULT $$Design Specification
Metallic epoxy design as approved via email, including agreed colour palette, description, and reference photos on previous quote. (sample board to be presented by photos before installation).

Terms
By accepting this invoice, the client confirms approval of the pre-installation guidelines, quotation, and Sunshine Resin's terms and conditions.$$;
