ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers
  ADD COLUMN assignment_revision integer NOT NULL CHECK (assignment_revision > 0),
  ADD COLUMN assignment_effective_from timestamptz NOT NULL,
  ADD COLUMN assignment_effective_to timestamptz;

ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers
  ADD CONSTRAINT billing_usage_period_assignment_bounds_check
  CHECK (assignment_effective_to IS NULL OR assignment_effective_to > assignment_effective_from),
  ADD CONSTRAINT billing_usage_period_assignment_coverage_check
  CHECK (assignment_effective_from <= period_start
    AND (assignment_effective_to IS NULL OR assignment_effective_to >= period_end));

COMMENT ON COLUMN __SOPHIA_RUNTIME_SCHEMA__.billing_usage_period_ledgers.assignment_revision IS
  'Snapshot of the commercial assignment revision used at finalisation; the mutable assignment row may later be ended.';
