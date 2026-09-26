# P4-03 checkpoint — shared presentation blocks and pack renderers

Date: 2026-09-25 (Australia/Brisbane)

Status: complete with v1 compatibility and media-policy limits

## Outcome

The kiosk now hosts one provider- and business-neutral presentation component.
It renders typed item lists, detail cards, media galleries, availability lists,
editable review cards, operation status and source lists using Angular text
binding only. It contains no property schema, property tool name or booking
workflow branch.

An exact multi-provider renderer registry owns tool-result selection. The
registered real-estate pack contains its legacy result validation, property and
booking types, tool activity labels, block mapping, review synchronisation and
explicit confirmation behavior. Generic review fields/actions remain in the
shared host rather than being duplicated in a property component. A generic
fixture renderer works without importing the real-estate pack.

Presentation media passes an explicit HTTPS hostname policy before it enters a
block. Unknown hosts, credentials in URLs, HTTP and non-web schemes are omitted.
The host never uses `innerHTML`, a sanitizer bypass or executable model markup.
Unknown tool names leave the active document unchanged, so forged student result
objects cannot activate quarantined student behavior. Student renderer files are
absent from the production runtime and kiosk chunks.

The real-estate renderer now displays all valid connector-returned availability
in chronological order rather than hiding rows outside the browser's current
month. Email provider acceptance is presented as processing, never as verified
recipient delivery.

## Plan correction

The active v1 tool route returns validated legacy output shapes instead of v2
`ToolResult.display` blocks. Plan version 2.1.13 therefore keeps that translation
inside the registered compatibility renderer. A future brokered v2 browser path
must select exact registered `schemaId` values from canonical display blocks.

The current connector media schema validates URL syntax but does not carry a
trusted host classification. P4-03 uses the existing Business Manager public
asset hostname as a pack-owned allowlist and drops other media. Additional or
tenant-configurable hosts require a server-owned connector/release media policy;
model output cannot expand browser egress.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` — passed under Node 20.19.1.
- `npm run test:sophia` — 40 tests passed in Chrome Headless 154, including a
  generic fixture without the real-estate pack, HTML-as-text rendering,
  renderer- and host-level media rejection, forged student-result rejection,
  future availability preservation and honest delivery status.
- `npm run test:p0:boundaries` — 119 new-product files passed.
- `npm run test:p0:real-estate` — 8 suites and 38 regression tests passed.
- `GOOGLE_MAPS_API_KEY=dummy npm run build` — passed. The kiosk lazy chunk fell
  from approximately 44.6 kB before the extraction to approximately 31.1 kB;
  existing bundle/font/CommonJS/missing PrimeIcons warnings remain.

No live provider, media origin, booking, email or deployment operation was
invoked. Visual provider-sandbox E2E remains unrun.

## Next ready task

P4-A02 — implement Organisations, Users and Permissions screens.
