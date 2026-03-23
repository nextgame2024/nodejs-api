-- Business Manager navigation links per company.
-- This controls which header/menu links are visible per client/company.

CREATE TABLE IF NOT EXISTS bm_navigation_links (
  navigation_link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id uuid NULL,
  navigation_type text NOT NULL,
  navigation_label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  createdat timestamptz NOT NULL DEFAULT NOW(),
  updatedat timestamptz NULL,
  CONSTRAINT fk_bm_navigation_links_company
    FOREIGN KEY (company_id)
    REFERENCES bm_company(company_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_bm_navigation_links_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE SET NULL,
  CONSTRAINT ck_bm_navigation_links_type
    CHECK (navigation_type IN ('header', 'menu')),
  CONSTRAINT ck_bm_navigation_links_label_nonempty
    CHECK (length(trim(navigation_label)) > 0)
);

-- No duplicate labels per company (case-insensitive, trimmed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bm_navigation_links_company_label
  ON bm_navigation_links (company_id, lower(trim(navigation_label)));

CREATE INDEX IF NOT EXISTS idx_bm_navigation_links_company
  ON bm_navigation_links (company_id);

CREATE INDEX IF NOT EXISTS idx_bm_navigation_links_company_type_active
  ON bm_navigation_links (company_id, navigation_type, active);
