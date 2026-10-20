import {describe,expect,jest,test} from '@jest/globals';
import {createStudentSyncCoordinator} from '../src/workers/student-sync-worker.js';

const tenant='11111111-1111-4111-8111-111111111111';
function fixture(time='2026-10-20T02:00:00+10:00') {
  let clock=new Date(time).getTime();
  const events=[];
  const runtime={processInvoices:jest.fn(async()=>{events.push('invoices');}),
    processDocument:jest.fn(async()=>{events.push('documents');return true;})};
  const processUsers=jest.fn(async()=>{events.push('students');});
  const log=jest.fn();
  const coordinator=createStudentSyncCoordinator({runtime,processUsers,customerIds:[tenant],now:()=>clock,log});
  return {runtime,processUsers,log,events,coordinator,advance:ms=>{clock+=ms;},set:time=>{clock=new Date(time).getTime();}};
}
describe('Shared student sync coordinator',()=>{
  test('polls invoice and manual user queues during the day without document discovery',async()=>{
    const f=fixture('2026-10-20T12:00:00+10:00');expect(await f.coordinator.tick()).toBe(15000);
    expect(f.events).toEqual(['invoices','students']);expect(f.processUsers).toHaveBeenCalledWith({schedule:true,throwOnError:true});
  });
  test('starts documents only at 03:00 Brisbane and stops starting them at 06:00',async()=>{
    const f=fixture('2026-10-20T02:59:59+10:00');await f.coordinator.tick();
    expect(f.runtime.processDocument).not.toHaveBeenCalled();f.advance(1000);await f.coordinator.tick();
    expect(f.runtime.processDocument).toHaveBeenCalledTimes(1);f.set('2026-10-20T06:00:00+10:00');await f.coordinator.tick();
    expect(f.runtime.processDocument).toHaveBeenCalledTimes(1);
  });
  test('runs stages sequentially and prevents overlapping ticks',async()=>{
    const f=fixture('2026-10-20T03:00:00+10:00');let release;
    f.runtime.processInvoices.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const first=f.coordinator.tick();await Promise.resolve();await f.coordinator.tick();
    expect(f.runtime.processInvoices).toHaveBeenCalledTimes(1);expect(f.processUsers).not.toHaveBeenCalled();
    release();await first;expect(f.events).toEqual(['students','documents']);
  });
  test('paces documents without polling invoice/user schedules for each source',async()=>{
    const f=fixture('2026-10-20T03:00:00+10:00');expect(await f.coordinator.tick()).toBe(2000);
    f.advance(2000);await f.coordinator.tick();expect(f.runtime.processDocument).toHaveBeenCalledTimes(2);
    expect(f.processUsers).toHaveBeenCalledTimes(1);f.advance(13000);await f.coordinator.tick();
    expect(f.processUsers).toHaveBeenLastCalledWith({schedule:false,throwOnError:true});
    f.advance(45000);await f.coordinator.tick();expect(f.processUsers).toHaveBeenLastCalledWith({schedule:true,throwOnError:true});
  });
  test('waits a minute on documents with no eligible source or provider backoff',async()=>{
    const f=fixture('2026-10-20T03:00:00+10:00');f.runtime.processDocument.mockResolvedValue(false);
    await f.coordinator.tick();f.advance(15000);await f.coordinator.tick();expect(f.runtime.processDocument).toHaveBeenCalledTimes(1);
    f.advance(45000);await f.coordinator.tick();expect(f.runtime.processDocument).toHaveBeenCalledTimes(2);
  });
  test('does not leak errors and retries a failed identity scheduling cycle',async()=>{
    const f=fixture();f.processUsers.mockRejectedValueOnce(new Error('postgresql://private-secret'));
    await f.coordinator.tick();expect(f.log).toHaveBeenCalledWith({event:'student_sync_stage_failed',stage:'students'});
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private-secret');f.advance(15000);await f.coordinator.tick();
    expect(f.processUsers).toHaveBeenLastCalledWith({schedule:true,throwOnError:true});
  });
  test('does not start another stage after a shutdown request',async()=>{
    const f=fixture('2026-10-20T03:00:00+10:00');const stop=new AbortController();
    f.runtime.processInvoices.mockImplementation(async()=>{stop.abort();});await f.coordinator.tick(stop.signal);
    expect(f.processUsers).not.toHaveBeenCalled();expect(f.runtime.processDocument).not.toHaveBeenCalled();
  });
  test('rejects missing or malformed tenant configuration before any jobs run',()=>{
    for(const ids of [[],['invalid']]) expect(()=>createStudentSyncCoordinator({runtime:{},processUsers:()=>{},customerIds:ids})).toThrow('customer IDs');
  });
});
