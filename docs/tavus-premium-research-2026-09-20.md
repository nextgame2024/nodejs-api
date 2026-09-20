# Tavus Premium research — 20 September 2026

Research only: no account settings, documents, subscriptions or live calls changed.

## Knowledge base recommendation

Tavus indexes uploaded files or public URLs and retrieves passages into a
conversation. Select ready documents with document_ids or document_tags during
conversation creation. Retrieval strategies are speed, balanced and quality;
the current technical guide lists quality as default. Its English-only document
support and preference for English conversations need explicit Spanish testing.
Website refresh is an explicit recrawl operation, not an assurance of automatic
freshness. See [technical guide](https://docs.tavus.io/sections/conversational-video-interface/knowledge-base).

Recommendation: keep Business Manager as the maintained source of content and
publish a versioned, reviewed subset to Tavus. Start with stable agency services,
appointment process and frequently asked questions. Use separate topic documents,
company scoping and revision dates. Exclude drafts, customer details and obsolete
revisions. Keep current-rule verification and booking availability/confirmation
on the existing tools. For migration facts, expiry and source checks must also be
enforced by our routing; document retrieval alone is not a freshness guarantee.

Test balanced against speed on the same questions. Measure answer correctness,
source/date accuracy and time from end of user speech to first audible response.
Use both English and Spanish. Retain tool fallback where retrieval is missing or
unsupported. Do not promise a fixed latency improvement before this comparison.
Tavus advertises approximately 30 ms retrieval in its own benchmarks; that is not
end-to-end response time. [Product description](https://www.tavus.io/lp/knowledge-base).

## Lip-sync and latency investigation

A knowledge base is not a direct lip-sync fix. Separate response generation delay
from media playback skew. Compare the same PAL/face/voice in Tavus's own preview
and Sophia on the same device and network, first with a stock face and then the
current face, in English and Spanish. Record startup time, end-of-turn to first
audio, visible mouth/audio alignment, dropped frames and network quality. Compare
median and slow-case timings across repeated turns, not one successful call.

Local code inspection shows Sophia attaches Tavus video and audio as separate
MediaStreams to separate HTML elements. This is a possible integration factor to
measure, not a confirmed cause. Test a synchronized combined playback stream in
an isolated branch before changing the live media path. If the issue also occurs
in Tavus preview, inspect the face model/training and voice configuration rather
than assuming an application bug. Tavus identifies unsuitable training footage
and incomplete lip closure as possible causes of poor face/lip quality:
[troubleshooting](https://docs.tavus.io/sections/troubleshooting).

Also check actual PAL settings against current Tavus recommendations before
changing them. The FAQ advises against Daily noise cancellation with Sparrow-2;
our shared microphone capture currently requests browser noise suppression.
Those are distinct mechanisms, so their effects need testing instead of assuming
that disabling browser processing fixes turn-taking. Tool execution, retrieval,
LLM/TTS generation and WebRTC playback require separate timing measurements.

## Usage and remaining minutes

Open [PAL Maker billing](https://maker.tavus.io/dev/billing) while signed into the
correct account/team. This is the dashboard linked by the official
[FAQ billing section](https://docs.tavus.io/sections/conversational-video-interface/faq#billing).
Check the current billing period, plan allocation and CVI/conversation usage,
not video-generation usage. Included remaining minutes are the allowance minus
usage, floored at zero; confirm any account-specific credits or terms there.
We have not read this account's private balance and cannot infer it from the
knowledge-base screenshot.

Session runtime, including connected idle time, counts. Paid plans may incur
automatic overage rather than stop when included minutes are exhausted. The
public pricing page currently specifies a 30-second minimum and six-second
rounding for each conversation. Therefore summing speech time or local session
logs is not a reliable invoice reconciliation. [Pricing](https://www.tavus.io/pricing).
