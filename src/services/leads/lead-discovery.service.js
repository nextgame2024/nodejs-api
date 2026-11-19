const s = "sophia_runtime";
export const discoveryFields = {
  business: "Business context",
  need: "Business need",
  outcome: "Desired outcome",
  systems: "Current tools or process",
  volume: "Workload",
  timeframe: "Timing",
  decisionProcess: "Decision process",
  followUpPreference: "Follow-up preference",
};
export async function discoveryInstalled(db) {
  return (
    await db.query(
      "SELECT to_regclass('sophia_runtime.assistant_lead_assessments') IS NOT NULL AS installed",
    )
  ).rows[0].installed;
}
// Public customer messages and accepted replies only. Never internal notes/drafts.
export async function publicConversation(
  db,
  tenant,
  conversationId,
  sourceEventId,
) {
  const rows = (
    await db.query(
      `SELECT event_id::text AS id,kind,body FROM ${s}.assistant_lead_events
    WHERE customer_id=$1 AND conversation_id=$2 AND event_id<=$3
    AND kind IN ('inbound_message','outbound_message') AND body<>''
    AND (kind='outbound_message' OR (metadata->>'messageType'='text' AND COALESCE(metadata->>'truncated','false')<>'true'))
    ORDER BY event_id DESC LIMIT 20`,
      [tenant, conversationId, sourceEventId],
    )
  ).rows;
  let remaining = 16000;
  return rows
    .filter((row) => {
      if (row.body.length > remaining) return false;
      remaining -= row.body.length;
      return true;
    })
    .reverse()
    .map((row) => ({
      id: row.id,
      role: row.kind === "inbound_message" ? "customer" : "assistant",
      text: row.body,
    }));
}
export async function readDiscovery(db, tenant, leadId) {
  if (!(await discoveryInstalled(db))) return null;
  const row = (
    await db.query(
      `SELECT facts,assessment,revision,source_event_id::text AS "sourceEventId",
    follow_up_status AS "followUpStatus",follow_up_due_at AS "followUpDueAt",updated_at AS "updatedAt",
    (SELECT jsonb_build_object('state',r.state,'dueAt',r.due_at,'deliveryState',o.state) FROM ${s}.assistant_follow_up_requests r
      LEFT JOIN ${s}.assistant_message_outbox o ON o.customer_id=r.customer_id AND o.follow_up_request_id=r.request_id
      WHERE r.customer_id=a.customer_id AND r.lead_id=a.lead_id ORDER BY r.created_at DESC LIMIT 1) AS "automaticFollowUp"
    FROM ${s}.assistant_lead_assessments a WHERE customer_id=$1 AND lead_id=$2`,
      [tenant, leadId],
    )
  ).rows[0];
  return row ?? null;
}
// A model may classify explicit statements, but cannot invent values, events or scores.
export function mergeDiscoveryFacts(previous, proposed, transcript) {
  const facts = { ...previous };
  if (!Array.isArray(proposed)) return facts;
  const customer = new Map(
    transcript.filter((x) => x.role === "customer").map((x) => [x.id, x.text]),
  );
  for (const item of proposed.slice(0, 16)) {
    if (
      !item ||
      !Object.hasOwn(discoveryFields, item.field) ||
      typeof item.quote !== "string" ||
      !item.quote.trim() ||
      item.quote.length > 600 ||
      typeof item.eventId !== "string" ||
      !customer.get(item.eventId)?.includes(item.quote)
    )
      continue;
    // Keep the latest statement, including corrections; never synthesize a quote.
    if (
      facts[item.field] &&
      BigInt(facts[item.field].eventId) > BigInt(item.eventId)
    )
      continue;
    facts[item.field] = { quote: item.quote, eventId: item.eventId };
  }
  return facts;
}
export function assessDiscovery(facts) {
  // Readiness to hold a useful discovery meeting, not personal worth or inferred revenue.
  const criteria = [
    ["need", 30, "Business need described"],
    ["outcome", 25, "Desired outcome described"],
    ["business", 15, "Business context provided"],
    ["systems", 10, "Current process described"],
    ["timeframe", 10, "Timing discussed"],
    ["decisionProcess", 10, "Decision process discussed"],
  ];
  const score = criteria.reduce(
    (n, [key, weight]) => n + (facts[key] ? weight : 0),
    0,
  );
  return {
    score,
    priority: score >= 70 ? "high" : score >= 40 ? "medium" : "early",
    scoreLabel: "Discovery readiness",
    reasons: criteria
      .filter(([key]) => facts[key])
      .map(([, weight, label]) => `${label} (+${weight})`),
    missing: criteria
      .filter(([key]) => !facts[key])
      .map(([key]) => discoveryFields[key]),
    summary: Object.entries(discoveryFields)
      .filter(([key]) => facts[key])
      .map(([key, label]) => ({ field: key, label, ...facts[key] })),
    nextStep:
      score >= 70
        ? "Review service fit and offer a discovery booking."
        : "Clarify the missing business needs before recommending a solution.",
    serviceFit:
      "Requires advisor review against approved services; no purchase intent or eligibility inferred.",
  };
}
export async function saveDiscovery(
  db,
  tenant,
  lead,
  job,
  proposed,
  transcript,
) {
  const previous = await readDiscovery(db, tenant, lead.lead_id);
  const facts = mergeDiscoveryFacts(
    previous?.facts ?? {},
    proposed,
    transcript,
  );
  if (
    !Object.keys(facts).length ||
    JSON.stringify(facts) === JSON.stringify(previous?.facts)
  )
    return;
  const assessment = assessDiscovery(facts);
  await db.query(
    `INSERT INTO ${s}.assistant_lead_assessments(customer_id,lead_id,facts,assessment,source_event_id,follow_up_due_at,conversation_id)
    VALUES($1,$2,$3::jsonb,$4::jsonb,$5,now()+$6::interval,$7)
    ON CONFLICT(customer_id,lead_id) DO UPDATE SET facts=EXCLUDED.facts,assessment=EXCLUDED.assessment,
    source_event_id=EXCLUDED.source_event_id,revision=assistant_lead_assessments.revision+1,updated_at=now()`,
    [
      tenant,
      lead.lead_id,
      JSON.stringify(facts),
      JSON.stringify(assessment),
      job.source_event_id,
      assessment.priority === "high" ? "1 day" : "3 days",
      job.conversation_id,
    ],
  );
  // Preserve the staff task's due date and disposition across subsequent messages.
}
