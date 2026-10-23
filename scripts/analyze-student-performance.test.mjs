import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerformanceReport, summarize } from './analyze-student-performance.mjs';

test('joins HAR and Runtime traces while discarding sensitive input', () => {
  const report = buildPerformanceReport({ scenario: 'sync-idle', har: {log:{entries:[{
    startedDateTime: '2026-10-20T01:00:00Z', time: 900,
    request:{method:'GET',url:'https://sophia-runtime-api.onrender.com/api/business-packs/student-operations/v1/workspace/student-register?q=PrivateStudent',headers:[{name:'Authorization',value:'Token private-secret'}]},
    response:{status:200,content:{text:'private-response'},headers:[{name:'X-Correlation-ID',value:'sample-1'},{name:'Server-Timing',value:'app;dur=650, guard_identity;dur=150, private_name;dur=5'}]},
    timings:{blocked:10,dns:-1,connect:30,ssl:20,send:5,wait:800,receive:55},
  }]}}, logText: 'Nest prefix '+JSON.stringify({event:'student_operations_timing',phase:'student-register',correlationId:'sample-1',outcome:'ok',totalMs:400,registerQueryMs:300,privateDetail:'private-log'})+' +2ms\n' });
  const students = report.operations.students;
  assert.equal(students.correlatedRequests,1);
  assert.equal(students.metrics['browser.outsideApplicationMs'].p50Ms,250);
  assert.equal(students.metrics['log.student-register.registerQueryMs'].p95Ms,300);
  assert.equal(students.metrics['browser.dnsMs'],undefined);
  assert.doesNotMatch(JSON.stringify(report),/PrivateStudent|private-secret|private-response|private-log|private_name|sample-1/);
});

test('supports old saved logs without HAR and does not double count correlated traces', () => {
  const lines = ['student-register','http-request'].map(phase => JSON.stringify({event:'student_operations_timing',phase,operation:'students',correlationId:'trace-1',totalMs:600,statusCode:200})).join('\n');
  const report=buildPerformanceReport({logText:lines});
  assert.equal(report.operations.students.metrics['log.student-register.totalMs'].samples,1);
  assert.equal(report.operations.students.metrics['log.http-request.totalMs'].samples,1);
  assert.equal(report.operations.students.browserRequests,0);
});

test('accepts spaced/quoted Server-Timing durations without admitting private or malformed metrics',()=>{
  const report=buildPerformanceReport({har:{log:{entries:[{
    request:{method:'GET',url:'https://example.com/api/business-packs/student-operations/v1/workspace/student-register'},
    time:1000,response:{status:200,headers:[{name:'Server-Timing',value:'app; dur=800.5, register_query ; dur = "400.25", PRIVATE_NAME; dur=20, invoices_total;dur=12oops, guard_total;dur=-1'}, {name:'server-timing',value:'proxy_only;desc="private-secret"'}]},
  }]}}});
  const students=report.operations.students;
  assert.equal(students.requestsWithServerTimings,1);
  assert.equal(students.metrics['server.appMs'].p50Ms,800.5);
  assert.equal(students.metrics['server.register_queryMs'].p50Ms,400.25);
  assert.equal(students.metrics['browser.outsideApplicationMs'].p50Ms,199.5);
  assert.equal(students.metrics['server.invoices_totalMs'],undefined);
  assert.equal(students.metrics['server.guard_totalMs'],undefined);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_NAME|example.com|proxy_only|private-secret/);
});

test('ignores malformed logs and unrelated traffic and keeps error samples visible', () => {
  const report=buildPerformanceReport({har:{log:{entries:[
    {request:{method:'GET',url:'https://example.com/elsewhere'},time:10},
    {request:{method:'POST',url:'https://example.com/api/business-packs/student-operations/v1/workspace'},time:10},
    {request:{method:'GET',url:'https://example.com/api/business-packs/student-operations/v1/workspace/student-register'},response:{status:500},time:50},
  ]}},logText:'not JSON\n{"event":"student_operations_timing",oops}\n'});
  assert.equal(report.operations.students.browserRequests,1);
  assert.equal(report.operations.students.responseStatuses[500],1);
  assert.deepEqual(summarize([NaN,-1,1,4,3,2]),{samples:4,p50Ms:2,p95Ms:4,maxMs:4});
  assert.throws(()=>buildPerformanceReport({scenario:'pretend-cold'}));
});
