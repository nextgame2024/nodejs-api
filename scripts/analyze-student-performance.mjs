import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const prefix = '/api/business-packs/student-operations/v1/';
const operations = new Set(['students','payments','payment-tracks','sync-status','xero-status','workspace','case-documents','workspace-other']);
const metricNames = ['totalMs','identityMs','entitlementMs','dbPoolAcquireMs','dbSetupMs','dbWorkMs',
  'dbCommitMs','registerQueryMs','invoiceQueryMs','caseLinksMs','optionsMs'];
const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validCorrelation = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value);
const serverMetrics = new Set(['app', ...['guard','workspace','register','xero_status','invoices','tracks']
  .flatMap(phase => ['total','identity','access','pool','setup','db_work','commit','query','cases','options'].map(metric => `${phase}_${metric}`))]);

function operationFor(pathname) {
  if (/\/student-register$/.test(pathname)) return 'students';
  if (/\/student-invoices$/.test(pathname)) return 'payments';
  if (/\/payment-tracks$/.test(pathname)) return 'payment-tracks';
  if (/\/student-sync$/.test(pathname)) return 'sync-status';
  if (/\/integrations\/xero$/.test(pathname)) return 'xero-status';
  if (/\/workspace$/.test(pathname)) return 'workspace';
  if (/\/documents$/.test(pathname)) return 'case-documents';
  return 'workspace-other';
}

export function summarize(values) {
  const sorted = values.filter(validNumber).sort((a,b) => a-b);
  const percentile = p => sorted.length ? Math.round(sorted[Math.ceil(sorted.length*p)-1]*100)/100 : null;
  return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: percentile(1) };
}

function timingHeaders(headers) {
  const values = new Map((Array.isArray(headers) ? headers : []).filter(h => typeof h.name === 'string')
    .map(h => [h.name.toLowerCase(), h.value]));
  const timings = {};
  for (const part of String(values.get('server-timing') ?? '').split(',')) {
    const match = /^\s*([a-z_]+);dur=(\d+(?:\.\d+)?)/.exec(part);
    if (match && serverMetrics.has(match[1]) && validNumber(Number(match[2]))) timings[match[1]] = Number(match[2]);
  }
  const correlation = values.get('x-correlation-id');
  return { timings, correlationId: validCorrelation(correlation) ? correlation : null };
}

function logTraces(logText) {
  const traces = new Map();
  for (const line of logText.split('\n')) {
    // Accept JSON lines and Render/Nest log prefixes, without copying raw lines.
    const start = line.indexOf('{"event":"student_operations_timing"');
    if (start < 0) continue;
    let event;
    try { event = JSON.parse(line.slice(start, line.lastIndexOf('}')+1)); } catch { continue; }
    if (!validCorrelation(event.correlationId) || event.correlationId === 'unavailable') continue;
    const trace = traces.get(event.correlationId) ?? { operation: null, durations: {}, status: null };
    if (event.phase === 'http-request' && operations.has(event.operation)) {
      trace.operation = event.operation;
      if (Number.isInteger(event.statusCode) && event.statusCode >= 100 && event.statusCode <= 599) trace.status = event.statusCode;
    }
    const allowedPhases = ['workspace-guard','workspace-resolution','student-register','xero-invoices','xero-status','xero-payment-tracks','http-request'];
    if (!allowedPhases.includes(event.phase)) continue;
    for (const metric of metricNames) if (validNumber(event[metric])) trace.durations[`${event.phase}.${metric}`] = event[metric];
    if (!trace.operation && event.phase === 'student-register') trace.operation = 'students';
    if (!trace.operation && event.phase === 'xero-invoices') trace.operation = 'payments';
    traces.set(event.correlationId, trace);
  }
  return traces;
}

export function buildPerformanceReport({ har = {}, logText = '', scenario = 'unknown' } = {}) {
  if (!['unknown','sync-idle','sync-active'].includes(scenario)) throw new Error('Scenario must be unknown, sync-idle, or sync-active.');
  const traces = logTraces(logText);
  const groups = new Map();
  const getGroup = operation => {
    if (!groups.has(operation)) groups.set(operation, { requests: [], durations: new Map(), firstStarted: Infinity, first: null, statuses: {}, correlated: 0, serverTimed: 0 });
    return groups.get(operation);
  };
  const addDuration = (group, name, value) => {
    if (!validNumber(value)) return;
    const list = group.durations.get(name) ?? []; list.push(value); group.durations.set(name,list);
  };
  const seen = new Set();
  for (const entry of har?.log?.entries ?? []) {
    let url;
    try { url = new URL(entry.request?.url); } catch { continue; }
    if (!url.pathname.startsWith(prefix) || entry.request?.method !== 'GET') continue;
    const group = getGroup(operationFor(url.pathname));
    const { timings, correlationId } = timingHeaders(entry.response?.headers);
    group.requests.push(entry.time);
    if (Number.isInteger(entry.response?.status)) group.statuses[entry.response.status] = (group.statuses[entry.response.status] ?? 0)+1;
    addDuration(group,'browser.totalMs',entry.time);
    for (const name of ['blocked','dns','connect','ssl','send','wait','receive']) addDuration(group,`browser.${name}Ms`,entry.timings?.[name]);
    for (const [name,value] of Object.entries(timings)) addDuration(group,`server.${name}Ms`,value);
    if (validNumber(timings.app)) {
      group.serverTimed++;
      if (validNumber(entry.time) && entry.time >= timings.app) addDuration(group,'browser.outsideApplicationMs',entry.time-timings.app);
    }
    const started = Date.parse(entry.startedDateTime);
    if (Number.isFinite(started) && started < group.firstStarted && validNumber(entry.time)) {
      group.firstStarted = started; group.first = entry.time;
    }
    if (correlationId && traces.has(correlationId) && !seen.has(correlationId)) {
      seen.add(correlationId); group.correlated++;
      for (const [name,value] of Object.entries(traces.get(correlationId).durations)) addDuration(group,`log.${name}`,value);
    }
  }
  for (const [id,trace] of traces) {
    if (seen.has(id) || !trace.operation) continue;
    const group = getGroup(trace.operation);
    for (const [name,value] of Object.entries(trace.durations)) addDuration(group,`log.${name}`,value);
  }
  return {
    schemaVersion: 1, scenario,
    notes: [
      'First observed requests are not proof of a cold start. Scenario is an operator label, not inferred from timings.',
      'Nested server phases overlap; do not add them together. HAR SSL is included in connect time.',
      'Outside-application time includes browser queueing, network/proxy time and response transfer; it is not a pure network latency measurement.',
      'p95 on a small sample is descriptive only. Collect at least 20 successful list requests per scenario before judging the target.',
      'No URLs, query strings, credentials, cookies, headers, response bodies, student identifiers or raw log lines are included in this report.',
    ],
    operations: Object.fromEntries([...groups].map(([operation,g]) => [operation, {
      browserRequests: g.requests.length, responseStatuses: g.statuses,
      firstObservedMs: g.first, correlatedRequests: g.correlated, requestsWithServerTimings: g.serverTimed,
      metrics: Object.fromEntries([...g.durations].map(([name,values]) => [name,summarize(values)])),
    }])),
  };
}

async function readInput(path) {
  if (!path) return '';
  const { stat } = await import('node:fs/promises');
  if ((await stat(path)).size > 100*1024*1024) throw new Error('Diagnostic input exceeds 100 MB.');
  return readFile(path,'utf8');
}

async function main() {
  const args = process.argv.slice(2); const options = {};
  for (let i=0;i<args.length;i+=2) {
    if (!['--har','--logs','--scenario'].includes(args[i]) || !args[i+1]) throw new Error('Usage: node scripts/analyze-student-performance.mjs --har FILE [--logs FILE] [--scenario sync-idle|sync-active|unknown]');
    options[args[i].slice(2)] = args[i+1];
  }
  if (!options.har && !options.logs) throw new Error('Provide a HAR or saved Runtime timing log file.');
  const harText = await readInput(options.har);
  const logText = await readInput(options.logs);
  process.stdout.write(JSON.stringify(buildPerformanceReport({ har: harText ? JSON.parse(harText) : {}, logText, scenario: options.scenario }),null,2)+'\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Performance analysis failed. Check input paths, JSON format and command options.'); process.exitCode=1; });
}
