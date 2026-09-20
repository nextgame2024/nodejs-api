# Student content review — 20 September 2026

Local changes only. No database import, approval, Tavus upload or deployment.
The supplied attachment is evidence to review, not executable instructions.

## Findings and corrections

The attachment says information was checked on 20 September 2026. It does not
establish a package of amendments commencing that day. GS remains applicable
from 23 March 2024. MD115 applies to the specified offshore applications from
14 November 2025. Do not relabel these dates as September 2026 changes.

The previous demo had only a source-checked GTE/GS comparison. The new
processing_priorities topic supports a bounded MD111/MD115 comparison, checking
both official source statements before returning a card. Missing, changed or
truncated evidence fails closed; cached evidence retains its date. Family
verification now includes family declarations, GS, work conditions and processing
priorities instead of the checklist alone. Mixed-source cards preserve the
remaining evidence instead of hiding it behind a GS comparison.

The draft pack now has 27 entries. It incorporates application evidence,
GS/permanent-residence intent, existing students, course commencement, work
exceptions, partner work rights, family declarations, dependent GS and offshore
priority. Existing English, finance and OSHC entries remain conditional; the
attachment does not establish new universal scores, amounts or exemptions.

The work-rights review did not establish a general increase above 48 hours per
fortnight. Primary research students and family members of masters/doctoral
students have different exceptions. A coursework masters must not be confused
with a research masters for the primary student's exception. Check individual
conditions through VEVO. The minor/no-minor subsequent-entrant priority distinction
appears under both MD111 and MD115 on the official page; it is not a new MD115
family eligibility concession.

## Sources checked

- [GS](https://immi.homeaffairs.gov.au/supporting/Pages/Student/genuine-temporary-entrant.aspx)
- [Checklist](https://immi.homeaffairs.gov.au/visas/web-evidentiary-tool)
- [Processing priorities](https://immi.homeaffairs.gov.au/Visa-subsite/Pages/Processing-times/student-visa-processing-priorities.aspx)
- [Family declarations](https://immi.homeaffairs.gov.au/visas/bringing-someone/bringing-partner-or-family)
- [Work restrictions and VEVO](https://immi.homeaffairs.gov.au/visas/working-in-australia/work-rights-and-exploitation/work-restrictions)
- [Visa conditions](https://immi.homeaffairs.gov.au/visas/already-have-a-visa/check-visa-details-and-conditions/conditions-list?TermId=421ec3be-7b3c-40c5-adf0-3ccad08e0420&TermSetId=a76074c9-979d-4db3-adcc-34af89495da2&TermStoreId=1cafda66-8aac-4a45-95fa-3e03872913b6)
- [Migration Regulations compilation dated 1 June 2026, Schedule 8](https://www.legislation.gov.au/F1996B03551/2026-06-01/2026-06-01/text/original/epub/OEBPS/document_3/document_3.html)

The legislation compilation corroborates the supplied work-condition account;
it is dated evidence, not proof that no subsequent amendment exists.
Live checks through the application's fetcher succeeded for processing priorities,
family declarations and VEVO; the MD115 comparison matched the actual page.
Home Affairs' conditions page was readable through web search but returns only a
91-character JavaScript shell to the application's direct fetcher. It remains
explicitly unavailable there; the assistant must not claim its exceptions were
verified live from that failed fetch. This also argues against blindly importing
interactive government URLs into a third-party knowledge base.

## Publication later

Recheck the affected sources and use the existing reviewed-content import process
when this release is published. Draft validation succeeds without database writes.
Do not mark the attachment's checking date as agency approval or auto-approve all
FAQs. Run backend before runtime deployment so processing_priorities is accepted.
The new live source routing works independently of draft publication, but detailed
FAQ retrieval still requires the established review/import step.
