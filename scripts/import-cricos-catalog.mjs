// Preview by default. Applying performs one atomic, tenant-scoped catalogue replacement.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './import-college-sites.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const providerPattern = /^\d{5}[A-Z0-9]$/u;

const institutionHeaders = ['CRICOS Provider Code', 'Trading Name', 'Institution Name', 'Institution Type',
  'Institution Capacity', 'Website', 'Postal Address Line 1', 'Postal Address Line 2', 'Postal Address Line 3',
  'Postal Address Line 4', 'Postal Address City', 'Postal Address State', 'Postal Address Postcode'];
const locationHeaders = ['CRICOS Provider Code', 'Institution Name', 'Location Name', 'Location Type',
  'Address Line 1', 'Address Line 2', 'Address Line 3', 'Address Line 4', 'City', 'State', 'Postcode'];
const courseHeaders = ['CRICOS Provider Code', 'Institution Name', 'CRICOS Course Code', 'Course Name',
  'VET National Code', 'Dual Qualification', 'Field of Education 1 Broad Field', 'Field of Education 1 Narrow Field',
  'Field of Education 1 Detailed Field', 'Field of Education 2 Broad Field', 'Field of Education 2 Narrow Field',
  'Field of Education 2 Detailed Field', 'Course Level', 'Foundation Studies', 'Work Component',
  'Work Component Hours/Week', 'Work Component Weeks', 'Work Component Total Hours', 'Course Language',
  'Duration (Weeks)', 'Tuition Fee', 'Non Tuition Fee', 'Estimated Total Course Cost', 'Expired'];
const courseLocationHeaders = ['CRICOS Provider Code', 'Institution Name', 'CRICOS Course Code', 'Location Name',
  'Location City', 'Location State'];

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const optional = (value) => clean(value) || null;
const identityKey = (value) => clean(value).toLocaleLowerCase('en-AU');
const joinKey = (...values) => values.map(identityKey).join('\u0000');
const address = (...values) => values.map(clean).filter(Boolean).join(', ') || null;
const locationKey = (row) => createHash('sha256').update(joinKey(
  row.providerCode, row.locationName, row.address, row.city, row.state, row.postcode,
)).digest('hex');

function table(text, expected, label) {
  const rows = parseCsv(String(text).replace(/^\uFEFF/u, ''));
  if (!rows.length || rows[0].length !== expected.length || rows[0].some((value, index) => clean(value) !== expected[index])) {
    throw new Error(`${label} must contain the official columns: ${expected.join(', ')}`);
  }
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== expected.length) throw new Error(`${label} row ${rowIndex + 2} has ${values.length} columns`);
    return Object.fromEntries(expected.map((header, index) => [header, clean(values[index])]));
  });
}

function integer(value, label, { allowNull = true } = {}) {
  const normalized = clean(value).replace(/,/gu, '');
  if (!normalized && allowNull) return null;
  if (!/^-?\d+$/u.test(normalized)) throw new Error(`${label} must be a whole number`);
  const result = Number(normalized);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside the supported range`);
  return result;
}

function decimal(value, label) {
  if (!clean(value)) return null;
  const result = Number(clean(value).replace(/,/gu, ''));
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label} must be a positive number`);
  return result;
}

function yesNo(value, label) {
  if (value === 'Yes') return true;
  if (value === 'No') return false;
  throw new Error(`${label} must be Yes or No`);
}

function money(value, label) {
  const normalized = clean(value).replace(/^\$AU\s*/u, '').replace(/^\$/u, '').replace(/,/gu, '');
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) throw new Error(`${label} is not a supported AUD amount`);
  return Math.round(Number(normalized) * 100);
}

export function planCricosImport(files) {
  const institutionRows = table(files.institutions, institutionHeaders, 'Institutions CSV');
  const locationRows = table(files.locations, locationHeaders, 'Locations CSV');
  const courseRows = table(files.courses, courseHeaders, 'Courses CSV');
  const courseLocationRows = table(files.courseLocations, courseLocationHeaders, 'Course locations CSV');

  const providers = institutionRows.map((row, index) => {
    const providerCode = row['CRICOS Provider Code'].toUpperCase();
    if (!providerPattern.test(providerCode) || !row['Institution Name']) {
      throw new Error(`Institutions CSV row ${index + 2} has an invalid provider code or institution name`);
    }
    return {
      providerCode,
      tradingName: optional(row['Trading Name']),
      institutionName: row['Institution Name'],
      institutionType: optional(row['Institution Type']),
      institutionCapacity: integer(row['Institution Capacity'], `Institution capacity at row ${index + 2}`),
      website: optional(row.Website),
      postalAddress: address(row['Postal Address Line 1'], row['Postal Address Line 2'], row['Postal Address Line 3'], row['Postal Address Line 4']),
      postalCity: optional(row['Postal Address City']),
      postalState: optional(row['Postal Address State']),
      postalPostcode: optional(row['Postal Address Postcode']),
    };
  });
  const providerMap = new Map();
  for (const provider of providers) {
    if (providerMap.has(provider.providerCode)) throw new Error(`Duplicate provider code ${provider.providerCode}`);
    providerMap.set(provider.providerCode, provider);
  }

  const locations = locationRows.map((row, index) => {
    const providerCode = row['CRICOS Provider Code'].toUpperCase();
    if (!providerMap.has(providerCode) || !row['Location Name']) {
      throw new Error(`Locations CSV row ${index + 2} has an unknown provider or incomplete location`);
    }
    const result = {
      providerCode,
      locationName: row['Location Name'],
      locationType: optional(row['Location Type']),
      address: address(row['Address Line 1'], row['Address Line 2'], row['Address Line 3'], row['Address Line 4']),
      city: optional(row.City),
      state: optional(row.State),
      postcode: optional(row.Postcode),
    };
    return { ...result, sourceKey: locationKey(result), matchKey: joinKey(providerCode, result.locationName, result.city, result.state) };
  });
  const sourceLocationKeys = new Set();
  for (const location of locations) {
    if (sourceLocationKeys.has(location.sourceKey)) throw new Error(`Duplicate physical location for ${location.providerCode}: ${location.locationName}`);
    sourceLocationKeys.add(location.sourceKey);
  }

  const courses = courseRows.map((row, index) => {
    const providerCode = row['CRICOS Provider Code'].toUpperCase();
    const courseCode = row['CRICOS Course Code'].toUpperCase();
    if (!providerMap.has(providerCode) || !courseCode || !row['Course Name']) {
      throw new Error(`Courses CSV row ${index + 2} has an unknown provider or incomplete course`);
    }
    return {
      providerCode, courseCode, courseName: row['Course Name'], vetNationalCode: optional(row['VET National Code']),
      dualQualification: yesNo(row['Dual Qualification'], `Dual qualification at row ${index + 2}`),
      field1Broad: optional(row['Field of Education 1 Broad Field']), field1Narrow: optional(row['Field of Education 1 Narrow Field']),
      field1Detailed: optional(row['Field of Education 1 Detailed Field']), field2Broad: optional(row['Field of Education 2 Broad Field']),
      field2Narrow: optional(row['Field of Education 2 Narrow Field']), field2Detailed: optional(row['Field of Education 2 Detailed Field']),
      courseLevel: optional(row['Course Level']), foundationStudies: yesNo(row['Foundation Studies'], `Foundation studies at row ${index + 2}`),
      workComponent: yesNo(row['Work Component'], `Work component at row ${index + 2}`),
      workComponentHoursWeek: decimal(row['Work Component Hours/Week'], `Work hours at row ${index + 2}`),
      workComponentWeeks: integer(row['Work Component Weeks'], `Work weeks at row ${index + 2}`),
      workComponentTotalHours: decimal(row['Work Component Total Hours'], `Total work hours at row ${index + 2}`),
      courseLanguage: optional(row['Course Language']), durationWeeks: integer(row['Duration (Weeks)'], `Duration at row ${index + 2}`),
      tuitionFeeCents: money(row['Tuition Fee'], `Tuition fee at row ${index + 2}`),
      nonTuitionFeeCents: money(row['Non Tuition Fee'], `Non-tuition fee at row ${index + 2}`),
      estimatedTotalCostCents: money(row['Estimated Total Course Cost'], `Estimated cost at row ${index + 2}`),
      expired: yesNo(row.Expired, `Expired at row ${index + 2}`),
    };
  });
  const courseMap = new Map();
  for (const course of courses) {
    if (courseMap.has(course.courseCode)) throw new Error(`Duplicate course code ${course.courseCode}`);
    courseMap.set(course.courseCode, course);
  }
  const locationsByMatch = new Map();
  for (const location of locations) locationsByMatch.set(location.matchKey, [...(locationsByMatch.get(location.matchKey) ?? []), location]);
  const courseLocations = [];
  const seenCourseLocations = new Set();
  for (const [index, row] of courseLocationRows.entries()) {
    const providerCode = row['CRICOS Provider Code'].toUpperCase();
    const courseCode = row['CRICOS Course Code'].toUpperCase();
    const course = courseMap.get(courseCode);
    if (!course || course.providerCode !== providerCode) throw new Error(`Course locations CSV row ${index + 2} has an unknown course`);
    const matches = locationsByMatch.get(joinKey(providerCode, row['Location Name'], row['Location City'], row['Location State'])) ?? [];
    if (!matches.length) throw new Error(`Course locations CSV row ${index + 2} has an unknown location`);
    // The source occasionally has two physical addresses with the same provider/name/city/state.
    // Because its mapping file cannot distinguish them, retain the course against both sites.
    for (const location of matches) {
      const key = `${courseCode}\u0000${location.sourceKey}`;
      if (!seenCourseLocations.has(key)) {
        seenCourseLocations.add(key);
        courseLocations.push({ courseCode, locationSourceKey: location.sourceKey });
      }
    }
  }
  return {
    providers, locations, courses, courseLocations,
    counts: {
      providers: providers.length,
      locations: locations.length,
      courses: courses.length,
      activeCourses: courses.filter((course) => !course.expired).length,
      courseLocations: courseLocations.length,
    },
  };
}

async function batches(rows, operation, size = 500) {
  for (let index = 0; index < rows.length; index += size) await operation(rows.slice(index, index + size));
}

export async function replaceCricosCatalog(db, companyId, plan) {
  if (!uuidPattern.test(companyId ?? '')) throw new Error('A valid company UUID is required');
  const syncedAt = new Date().toISOString();
  await db.query('BEGIN');
  try {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cricos-catalog:${companyId}`]);
    const company = await db.query('SELECT company_id FROM bm_company WHERE company_id = $1 FOR UPDATE', [companyId]);
    if (company.rows.length !== 1) throw new Error('Business Manager company not found');
    const old = await db.query('SELECT college_id, college_name, cricos_provider_code FROM bm_colleges WHERE company_id = $1 FOR UPDATE', [companyId]);

    const providersByName = new Map();
    for (const provider of plan.providers) {
      for (const name of [provider.institutionName, provider.tradingName]) {
        if (!name) continue;
        const key = identityKey(name);
        const values = providersByName.get(key) ?? new Set();
        values.add(provider.providerCode);
        providersByName.set(key, values);
      }
    }
    const reusable = new Map();
    for (const row of old.rows) {
      let providerCode = row.cricos_provider_code;
      if (!providerCode) {
        const matches = providersByName.get(identityKey(row.college_name));
        if (matches?.size === 1) providerCode = [...matches][0];
      }
      if (providerCode && !reusable.has(providerCode)) reusable.set(providerCode, row.college_id);
    }

    const providerIds = new Map(plan.providers.map((provider) => [provider.providerCode, reusable.get(provider.providerCode) ?? randomUUID()]));
    const firstSite = new Map();
    for (const location of plan.locations) if (!firstSite.has(location.providerCode)) firstSite.set(location.providerCode, location);
    await db.query('DELETE FROM bm_colleges WHERE company_id = $1', [companyId]);

    await batches(plan.providers.map((provider) => ({
      id: providerIds.get(provider.providerCode), ...provider,
      primaryAddress: firstSite.get(provider.providerCode)?.address ?? null,
      primaryCity: firstSite.get(provider.providerCode)?.city ?? null,
      primaryCategory: firstSite.get(provider.providerCode)?.locationType ?? null,
    })), async (rows) => db.query(`INSERT INTO bm_colleges
      (college_id,company_id,college_name,owner_name,address,city,category,status,cricos_provider_code,trading_name,
       institution_type,institution_capacity,website,postal_address,postal_city,postal_state,postal_postcode,cricos_synced_at)
      SELECT x.id,$1,x.institution_name,x.trading_name,x.primary_address,x.primary_city,x.primary_category,'active',
        x.provider_code,x.trading_name,x.institution_type,x.institution_capacity,x.website,x.postal_address,x.postal_city,
        x.postal_state,x.postal_postcode,$2::timestamptz
      FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,provider_code text,trading_name text,institution_name text,
        institution_type text,institution_capacity integer,website text,postal_address text,postal_city text,postal_state text,
        postal_postcode text,primary_address text,primary_city text,primary_category text)`, [companyId, syncedAt, JSON.stringify(rows.map((row) => ({
      id: row.id, provider_code: row.providerCode, trading_name: row.tradingName, institution_name: row.institutionName,
      institution_type: row.institutionType, institution_capacity: row.institutionCapacity, website: row.website,
      postal_address: row.postalAddress, postal_city: row.postalCity, postal_state: row.postalState,
      postal_postcode: row.postalPostcode, primary_address: row.primaryAddress, primary_city: row.primaryCity,
      primary_category: row.primaryCategory,
    })))]));

    const siteIds = new Map();
    const siteCount = new Map();
    const siteRows = plan.locations.map((location) => {
      const id = randomUUID();
      siteIds.set(location.sourceKey, id);
      const count = siteCount.get(location.providerCode) ?? 0;
      siteCount.set(location.providerCode, count + 1);
      return { id, collegeId: providerIds.get(location.providerCode), primary: count === 0, ...location };
    });
    await batches(siteRows, async (rows) => db.query(`INSERT INTO bm_college_sites
      (site_id,company_id,college_id,address,city,category,is_primary,cricos_location_key,location_name,location_type,state,postcode)
      SELECT x.id,$1,x.college_id,x.address,x.city,x.location_type,x.is_primary,x.source_key,x.location_name,x.location_type,x.state,x.postcode
      FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,college_id uuid,address text,city text,location_type text,is_primary boolean,
        source_key text,location_name text,state text,postcode text)`, [companyId, JSON.stringify(rows.map((row) => ({
      id: row.id, college_id: row.collegeId, address: row.address, city: row.city, location_type: row.locationType,
      is_primary: row.primary, source_key: row.sourceKey, location_name: row.locationName, state: row.state, postcode: row.postcode,
    })))]));

    const courseIds = new Map();
    const courseRows = plan.courses.map((course) => {
      const id = randomUUID(); courseIds.set(course.courseCode, id);
      return { id, collegeId: providerIds.get(course.providerCode), ...course };
    });
    await batches(courseRows, async (rows) => db.query(`INSERT INTO bm_college_courses
      (course_id,company_id,college_id,cricos_course_code,course_name,vet_national_code,dual_qualification,
       field_1_broad,field_1_narrow,field_1_detailed,field_2_broad,field_2_narrow,field_2_detailed,course_level,
       foundation_studies,work_component,work_component_hours_week,work_component_weeks,work_component_total_hours,
       course_language,duration_weeks,tuition_fee_cents,non_tuition_fee_cents,estimated_total_cost_cents,expired,cricos_synced_at)
      SELECT x.id,$1,x.college_id,x.course_code,x.course_name,x.vet_code,x.dual,x.f1b,x.f1n,x.f1d,x.f2b,x.f2n,x.f2d,
        x.level,x.foundation,x.work,x.work_hours,x.work_weeks,x.work_total,x.language,x.duration,x.tuition,x.non_tuition,
        x.estimated,x.expired,$2::timestamptz
      FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,college_id uuid,course_code text,course_name text,vet_code text,
        dual boolean,f1b text,f1n text,f1d text,f2b text,f2n text,f2d text,level text,foundation boolean,work boolean,
        work_hours numeric,work_weeks integer,work_total numeric,language text,duration integer,tuition bigint,non_tuition bigint,
        estimated bigint,expired boolean)`, [companyId, syncedAt, JSON.stringify(rows.map((row) => ({
      id: row.id, college_id: row.collegeId, course_code: row.courseCode, course_name: row.courseName,
      vet_code: row.vetNationalCode, dual: row.dualQualification, f1b: row.field1Broad, f1n: row.field1Narrow,
      f1d: row.field1Detailed, f2b: row.field2Broad, f2n: row.field2Narrow, f2d: row.field2Detailed,
      level: row.courseLevel, foundation: row.foundationStudies, work: row.workComponent,
      work_hours: row.workComponentHoursWeek, work_weeks: row.workComponentWeeks, work_total: row.workComponentTotalHours,
      language: row.courseLanguage, duration: row.durationWeeks, tuition: row.tuitionFeeCents,
      non_tuition: row.nonTuitionFeeCents, estimated: row.estimatedTotalCostCents, expired: row.expired,
    })))]));

    const linkRows = plan.courseLocations.map((link) => ({ courseId: courseIds.get(link.courseCode), siteId: siteIds.get(link.locationSourceKey) }));
    await batches(linkRows, async (rows) => db.query(`INSERT INTO bm_college_course_locations(company_id,course_id,site_id)
      SELECT $1,x.course_id,x.site_id FROM jsonb_to_recordset($2::jsonb) AS x(course_id uuid,site_id uuid)`,
    [companyId, JSON.stringify(rows.map((row) => ({ course_id: row.courseId, site_id: row.siteId })))]));
    await db.query('COMMIT');
    return { replacedColleges: old.rows.length, preservedCollegeIds: reusable.size, ...plan.counts, syncedAt };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const files = {
    institutions: value('institutions'), locations: value('locations'), courses: value('courses'),
    courseLocations: value('course-locations'),
  };
  const companyId = value('company-id');
  const apply = args.includes('--apply');
  const confirm = args.includes('--confirm-replace');
  const validArgs = new Set(['--apply', '--confirm-replace']);
  if (Object.values(files).some((file) => !file) || args.some((arg) => !arg.includes('=') && !validArgs.has(arg))) {
    throw new Error('Usage: node scripts/import-cricos-catalog.mjs --institutions=... --locations=... --courses=... --course-locations=... [--company-id=UUID --apply --confirm-replace]');
  }
  if (apply && (!uuidPattern.test(companyId ?? '') || !confirm)) throw new Error('Apply requires --company-id=UUID and --confirm-replace');
  const contents = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await readFile(file, 'utf8')])));
  const plan = planCricosImport(contents);
  if (!apply) { console.log(JSON.stringify({ mode: 'preview', ...plan.counts }, null, 2)); return; }
  const { default: pool } = await import('../src/config/db.js');
  const db = await pool.connect();
  try {
    const result = await replaceCricosCatalog(db, companyId, plan);
    console.log(JSON.stringify({ mode: 'applied', companyId, ...result }, null, 2));
  } finally {
    db.release(); await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
