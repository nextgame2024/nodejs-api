import { preparationConfigs } from '../scheduling/meeting-preparation.js';
export function formUrl(token, slug, tenant) {
  if (!token) return null;
  const config = preparationConfigs()[tenant];
  const alias = config && [config, ...(config.aliases ?? [])].find(p => p.publicToken === token);
  const origin = config?.origin || process.env.PUBLIC_FORM_ORIGIN || 'https://sophiaai.com.au';
  return alias || slug ? new URL('/forms/' + (alias?.slug || slug), origin).href : null;
}
export async function assignFormSlug(db, tenant, id) {
  if (!(await db.query("SELECT to_regprocedure('sophia_runtime.assign_lead_form_slug(uuid,uuid,text[])') IS NOT NULL AS installed")).rows[0].installed) return null;
  const reserved = Object.values(preparationConfigs()).flatMap(p => [p, ...(p.aliases ?? [])]).map(p => p.slug);
  return (await db.query('SELECT sophia_runtime.assign_lead_form_slug($1,$2,$3::text[]) AS slug', [tenant, id, reserved])).rows[0].slug;
}
