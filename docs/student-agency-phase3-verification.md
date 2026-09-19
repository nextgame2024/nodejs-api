# Phase 3 verification and rollout

## Changes

- Student knowledge and official-evidence responses now contain display cards.
- `compareStudentRules` returns prior/new rules, new/current student effects,
  effective dates, applicability, source URLs and evidence status.
- A live-source GS/GTE transition example checks both source statements before
  presenting the comparison; unsupported historical facts stay unknown.
- Optional comparison baseline avoids presenting an older change as one that
  happened within the requested recent period.
- A dedicated student panel renders these results in Essential, Professional and
  Premium via the common kiosk tool-result path. Cards distinguish live retrieval,
  previously reviewed answers, cached copies and unavailable evidence.
- Domain switching clears property panels/photos/reviews; inspection review
  state is invalidated on the runtime for the switching session only. Delayed
  responses from the previous domain are ignored by the kiosk.
- Date-only rule commencement dates are normalized to UTC midnight so the
  displayed calendar day does not shift with the browser timezone.

## Database work completed

Applied the additive student knowledge and source snapshot schema to the connected
PostgreSQL database. Imported 20 draft FAQs into the sole company that owns the
40 existing demo properties. No real-estate tables, slots, bookings or emails were
changed. No draft was represented as agency-approved. The GS live source snapshot
was saved; the comparison service returned `supported_comparison` with live evidence.

## Validation

- 21 backend comparison, knowledge, source and property booking tests passed.
- 21 relevant runtime tests passed, including session-scoped review invalidation.
- 6 ChromeHeadless tests passed: link validation, announced/cached/unknown states,
  effective dates, accessible close, domain switching and delayed tool responses.
- Runtime TypeScript check and frontend production build passed.
- Production build still reports initial/font-size budget, HeyGen CommonJS and
  missing `/assets/primeicons/primeicons.css` warnings.
- `git diff --check` passed in both repositories.

No live avatar conversation or production app deployment was performed. Deploy
backend first, then Sophia Runtime and frontend together so tool names and card
rendering agree. The database is prepared already. Consultation booking is Phase 4.

## Suggested demo

Ask about the Genuine Student requirement, then ask what replaced GTE and how the
change applies to a new application versus someone already studying. Ask to show
changes since 2025 to confirm this 2024 transition is not presented as a newer
change. Ask for a rental property next; the student panel should close and the
existing property flow should resume. Return to student guidance to confirm a
prior inspection review cannot be reused without a new review and confirmation.
