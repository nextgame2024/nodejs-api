# Sophia student-agency implementation plan

Support real estate (buy/rent, inspection booking, report/email) and Australian
student migration enquiries in the same Sophia experience. Domain follows the
user's request; ambiguous enquiries require clarification. Student housing remains
a property enquiry. Student consultations have their own appointments and must
never consume property inspection slots or trigger Town Planner reports.

## Phase 1 — Domain and knowledge foundations (implemented locally)

- Separate company-scoped `bm_student_agency_knowledge` table and authenticated
  GET `/api/bm/student-agency/knowledge?q=...` endpoint.
- Structured previous/current rules, new/current student impacts, applicability,
  effective dates, announced/in-force/superseded status, official sources,
  reviewer, verification date and review expiry.
- Only approved, unexpired records with approved official source URLs are exposed.
  Drafts default to unpublished; an empty result is `verification_required`.
- Register `searchStudentAgencyKnowledge` alongside existing property tools.
  Clarify ambiguous domain requests; no rental fallback for migration questions.
- No migration facts are seeded or labelled approved without review. No live
  verification or student consultation booking is claimed in this phase.
- Acceptance: runtime compiles; domain tool validation, outage behaviour and
  source filtering pass; existing property booking and email tests still pass.

Deploy backend before runtime. Backend startup creates the additive table; no
existing property tables are repurposed. No production migration or deployment
was performed during implementation. Phase 1 is a foundation, not the finished
customer demonstration. Frontend changes begin in Phase 3.

## Phase 2 — Reviewed content and official verification (implementation complete locally; agency publication pending)

Implementation and operator instructions: [student-agency-content-operations.md](student-agency-content-operations.md). Twenty sourced drafts, a validation/import/publication workflow and official-page retrieval are implemented. Agency identity and human content sign-off remain outstanding; no draft is represented as approved.

1. Confirm agency identity, services, consultation fees, advisers and whether it
   provides registered migration assistance or education services only.
2. Prepare approximately 20 FAQs: student visa documents, Genuine Student,
   English evidence, financial evidence, OSHC, work conditions, dependants,
   course changes, agency processes and consultation preparation.
3. Build a controlled content import/review process in Business Manager. Agency
   service information is distinct from government requirements. Record reviewer,
   official URL, source excerpt, checked date, effective date, applicability and
   superseded version. Do not invent historical rules or approval dates.
4. Official source registry: Home Affairs student visa guidance and document
   checklist; Department of Education; Study Australia; legislation.gov.au when
   necessary; OMARA for adviser scope. Add sources only after deliberate review.
5. Retrieve official page content for latest/current/change questions; exact host
   allowlist, redirect revalidation, network timeouts and size limits. External
   page content is evidence, never executable instructions. Handle blocked or
   unavailable pages with dated reviewed information or an agent handoff.
6. Cache evidence with verification time and retain change history. Fetching a
   page today does not mean a rule became effective today. Search snippets alone
   cannot establish a rule or the absence of changes.

Acceptance: each published FAQ has traceable evidence and agency review; stale,
missing, contradictory and unavailable sources do not yield confident current
claims. Adviser assessment handles personal eligibility and visa strategy.

## Phase 3 — Rule comparisons and student answer cards (implemented locally; database prepared)

Implemented: `compareStudentRules`, student answer/evidence/comparison panels,
source links and timestamps, baseline filtering and unknown-impact states. The
first live-source comparison is the documented GTE → GS transition. It is shown
only when both old/new statements still occur in the official page; it is not a
comprehensive catalogue of visa changes. Other topics need reviewed comparison
records with historical and current evidence. On topic switches, property panels
and pending inspection reviews are cleared; late responses cannot reopen the
previous domain's panel. All enabled avatar plans share the same tool display path.

Database setup has now been applied to the existing Sophia demo company: the
student knowledge/source-history tables exist and 20 FAQs are seeded as drafts.
No agency approvals were invented. A live GS source snapshot was saved and the
comparison returned `supported_comparison`. App services have not been deployed.
See [Phase 3 verification](student-agency-phase3-verification.md).

- Dedicated comparison output: previous rule, new rule, announcement/effective
  dates, new-applicant impact, current-student impact, exceptions, uncertainties,
  source links and verification date. Scope "what changed" to a topic/time period.
- Ask only necessary context: inside/outside Australia, course/intake, application
  or grant dates where relevant. "Current student" alone does not establish
  grandfathering. Do not extrapolate individual eligibility.
- Render student cards separately from property/inspection panels. Domain switches
  close irrelevant panels; do not reuse property booking review state.
- Brief spoken answer with details on screen; explicit labels for a verified
  current source versus a previously reviewed snapshot.

Acceptance: reviewed old/new fixtures for new applicants, existing students,
transitional dates and announced-but-not-effective changes; missing historical
facts stay unknown. Validate on all enabled avatar plans.

## Phase 4 — Student-agent consultation booking (implemented locally; demo calendar seeded)

Implementation, queue operations and validation: [Phase 4 verification](student-agency-phase4-verification.md). The connected demo company has a separate synthetic adviser calendar. Application deployment and live delivery verification remain for Phase 5.

- Reuse the inspection UX sequence: available times → selection → name/email →
  editable review → explicit confirmation → booking → confirmation email.
- Separate agent/service calendar, consultation slots, bookings and durable email
  delivery records; company scoping, capacity/concurrency protection, idempotency,
  timezone labels and corrected-email resend support.
- Student-specific tools for slots, review, booking and resend. Pending reviews
  are session-scoped and tied to their domain; no property IDs or report jobs.
- Email includes confirmed appointment and, with consent, enquiry summary and
  official links. Never attach a Town Planner report to student consultations.
- Create customer-visible availability from the agency's actual calendar or
  explicitly approved demo schedule; do not pretend demo times are real.

Acceptance: duplicate/racing requests, full slots, time mismatch, edited details,
unconfirmed requests, retries and recipient correction; consultation success and
email delivery status communicated separately.

## Phase 5 — Combined demo and release validation (validation passed; deployment pending)

Validation and handoff: [Phase 5 release report](student-agency-phase5-release.md). Automated suites and the live consultation email rehearsal passed; the user confirmed inbox receipt. Live source retrieval and demo availability were checked. Public service deployment and the live avatar rehearsal remain pending.

- Regress buy/rent searches, inspections, purchase report/email and resends.
- Test student Q&A, official verification, comparisons, cards, booking and email.
- Test switching property → student → property in one session and independent
  concurrent sessions. Include ambiguous "application"/"agent"/"fees" requests.
- Agency signs off knowledge and example scenarios. Use consenting demo recipients.
- Refresh evidence before presentation, monitor queue errors, and rehearse source
  outages with dated fallback. Publish only after end-to-end acceptance.

Five-minute demo: student asks about requirements → asks what changed → sees
previous/new comparison and effects on existing/new students → asks about their
situation → reviews and confirms an adviser consultation → receives confirmation.
Then demonstrate a rental or purchase enquiry to show both domains coexist.
