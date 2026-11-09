import pool from '../config/db.js';
import { commissionDecimal } from '../utils/commissionDecimal.js';

const fields = `rule_id AS "ruleId", college_id AS "collegeId", classification, location, program,
  commission_basis_points AS "commissionBasisPoints", calculation_method AS "calculationMethod",
  calculation_description AS "calculationDescription", rounding_decimal_places AS "roundingDecimalPlaces",
  cashback_status AS "cashbackStatus", cashback_description AS "cashbackDescription",
  cashback_calculation_description AS "cashbackCalculationDescription", cashback_calculation AS "cashbackCalculation",
  bonus_amount AS "bonusAmount", bonus_status AS "bonusStatus",
  bonus_description AS "bonusDescription", application_conditions AS "applicationConditions",
  active, createdat AS "createdAt", updatedat AS "updatedAt"`;
const conditionFields = ['classification', 'location', 'program'];
const key = value => value?.toLocaleLowerCase('en-AU') ?? null;
const fail = (message, code = 'INVALID_COMMISSION') => Object.assign(new Error(message), { code });

export function validateCommission(value, editing = false) {
  const allowed = ['classification','location','program','commission_basis_points','cashback_status',
    'cashback_description','cashback_calculation_description','cashback_calculation','bonus_amount','bonus_status','bonus_description','application_conditions',
    ...(editing ? ['expected_updated_at'] : [])];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) {
    throw fail('Enter valid commission rule fields.');
  }
  const result = {};
  for (const [field, max] of [['classification',10],['location',10],['program',300],['cashback_description',2000],
    ['cashback_calculation_description',2000],['bonus_description',2000],['application_conditions',5000]]) {
    const text = value[field];
    if (text != null && (typeof text !== 'string' || text.length > max)) throw fail(`Enter a valid ${field.replaceAll('_',' ')}.`);
    result[field] = text?.normalize('NFKC').replace(/\s+/gu,' ').trim() || null;
  }
  if (![null,'ELICOS','VET','HE'].includes(result.classification) || ![null,'ON-SHORE','OFF-SHORE'].includes(result.location)) {
    throw fail('Choose a valid classification and location.');
  }
  if (!Number.isInteger(value.commission_basis_points) || value.commission_basis_points < 0 || value.commission_basis_points > 10000) {
    throw fail('Commission must be between 0% and 100%, with up to two decimal places.');
  }
  result.commission_basis_points = value.commission_basis_points;
  for (const benefit of ['cashback','bonus']) {
    if (!['not_recorded','not_applicable','specified'].includes(value[`${benefit}_status`])) throw fail(`Choose a valid ${benefit} status.`);
    result[`${benefit}_status`] = value[`${benefit}_status`];
    const numericField = benefit === 'cashback' ? 'cashback_calculation' : 'bonus_amount';
    try { result[numericField] = commissionDecimal(value[numericField],benefit === 'cashback' ? 'Cashback calculation' : 'Bonus'); }
    catch (error) { throw fail(error.message); }
    if (result[`${benefit}_status`] === 'specified' && result[numericField] === null) throw fail(`Enter the numeric value for the specified ${benefit}.`);
    if (result[`${benefit}_status`] !== 'specified' && result[numericField] !== null) throw fail(`Choose Specified to record a numeric ${benefit}.`);
  }
  if (editing) {
    if (typeof value.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(value.expected_updated_at))) throw fail('Reload the rule before editing.');
    result.expected_updated_at = value.expected_updated_at;
  }
  return result;
}

export function assertUnambiguousCommission(value, existing) {
  const specificity = conditionFields.filter(k => value[k]).length;
  for (const other of existing) {
    const overlap = conditionFields.every(k => !value[k] || !other[k] || key(value[k]) === key(other[k]));
    if (overlap && specificity === conditionFields.filter(k => other[k]).length) {
      throw fail('An active rule already matches these conditions at the same specificity. Edit that rule or use more specific conditions.', 'COMMISSION_CONFLICT');
    }
  }
}

export async function listCommissions(companyId, collegeId) {
  const parent = await pool.query('SELECT college_id FROM bm_colleges WHERE company_id=$1 AND college_id=$2',[companyId,collegeId]);
  if (!parent.rows.length) return null;
  return (await pool.query(`SELECT ${fields} FROM bm_college_commission_rules
    WHERE company_id=$1 AND college_id=$2 AND active ORDER BY createdat,rule_id`,[companyId,collegeId])).rows;
}

// Parent locking serializes changes. Replaced rules remain archived for historical references.
export async function saveCommission(companyId, collegeId, ruleId, value, archive = false) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const parent = await db.query('SELECT college_id FROM bm_colleges WHERE company_id=$1 AND college_id=$2 FOR UPDATE',[companyId,collegeId]);
    if (!parent.rows.length) { await db.query('ROLLBACK'); return null; }
    const existing = (await db.query(`SELECT rule_id,classification,location,program,updatedat FROM bm_college_commission_rules
      WHERE company_id=$1 AND college_id=$2 AND active FOR UPDATE`,[companyId,collegeId])).rows;
    if (ruleId) {
      const prior = existing.find(r => r.rule_id === ruleId);
      if (!prior) throw fail('This rule has already changed or been archived. Reload the rules.', 'COMMISSION_CONFLICT');
      if (new Date(prior.updatedat).getTime() !== Date.parse(value.expected_updated_at)) {
        throw fail('This rule has changed since you opened it. Reload the rules before saving.', 'COMMISSION_CONFLICT');
      }
    }
    if (!archive) assertUnambiguousCommission(value,existing.filter(r => r.rule_id !== ruleId));
    if (ruleId) await db.query('UPDATE bm_college_commission_rules SET active=false,updatedat=now() WHERE company_id=$1 AND college_id=$2 AND rule_id=$3',[companyId,collegeId,ruleId]);
    let result = { archived: true };
    if (!archive) {
      result = (await db.query(`INSERT INTO bm_college_commission_rules
        (company_id,college_id,classification,location,program,commission_basis_points,calculation_description,
         cashback_status,cashback_description,cashback_calculation_description,bonus_status,bonus_description,application_conditions,
         cashback_calculation,bonus_amount)
        VALUES($1,$2,$3,$4,$5,$6,'Tuition fee x commission (2 decimals)',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${fields}`,
      [companyId,collegeId,value.classification,value.location,value.program,value.commission_basis_points,
        value.cashback_status,value.cashback_description,value.cashback_calculation_description,value.bonus_status,
        value.bonus_description,value.application_conditions,value.cashback_calculation ?? null,value.bonus_amount ?? null])).rows[0];
    }
    await db.query('COMMIT'); return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw fail('An active rule already uses these conditions. Reload and edit that rule.', 'COMMISSION_CONFLICT');
    throw error;
  } finally { db.release(); }
}
