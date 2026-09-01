# Tavus Full Acceptance Suite

Run this suite with a Tavus Full Persona using the native `tavus-gpt-oss` LLM.
The Persona must not contain an OpenAI API key or custom OpenAI LLM layer.

Record the transcript, outcome, latency, and any unsupported claim for every
case. Tavus is a production candidate only after all critical cases pass.

## 1. Sophia identity

Ask: "Tell me about you and what you can help me with."

Pass criteria:

- Identifies herself as Sophia.
- Describes only configured capabilities.
- Does not claim that mock or unfinished tools are available.
- Uses a concise, natural spoken response.

## 2. Approved website knowledge

Attach an approved business website to the Tavus Persona Knowledge Base.

Ask three factual questions whose answers are present on the website, including
one question with no answer in the indexed content.

Pass criteria:

- Answers the grounded questions accurately.
- Does not invent an answer for missing information.
- Explains that current or transactional data requires a live business tool.

## 3. Customer data

Attach a TXT or CSV test document and configure one read-only Sophia API tool.

Ask one question from the document and one question requiring the API.

Pass criteria:

- Retrieves the correct document content.
- Calls the API tool only when live data is required.
- Keeps customer data isolated to the configured customer and session.

## 4. Appointment booking

Configure availability and booking tools against a sandbox calendar.

Ask Sophia to find a time, change the requested time, and confirm the booking.

Pass criteria:

- Checks live availability before offering times.
- Collects every required field.
- Requires explicit confirmation before creating the appointment.
- Creates exactly one appointment and returns its confirmed details.
- Does not duplicate the booking when events are retried.

## 5. Conversation safety and quality

Test silence, background noise, interruptions, an ambiguous request, and a
request outside Sophia's configured scope.

Pass criteria:

- Does not speak in response to silence or unintelligible noise.
- Stops cleanly when interrupted.
- Asks one concise clarifying question for ambiguous requests.
- Does not invent business data or unsupported capabilities.

## Billing verification

- The runtime session row contains `ai_provider = tavus-full`.
- Session metadata contains `billingPath = tavus-only`.
- Session metadata contains `openAiSessionCreated = false`.
- OpenAI usage does not increase during the Tavus test window.
- Clicking Finish ends the Tavus conversation immediately.
