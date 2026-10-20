import { jest } from '@jest/globals';
import { StudentOperationsXeroSyncScheduler } from './student-operations-xero-sync.scheduler.js';

describe('Dedicated invoice scheduler',()=>{
  const oldUrl=process.env.SOPHIA_RUNTIME_DATABASE_URL;
  beforeAll(()=>{process.env.SOPHIA_RUNTIME_DATABASE_URL='postgresql://example.invalid/runtime';});
  afterAll(()=>{if(oldUrl===undefined) delete process.env.SOPHIA_RUNTIME_DATABASE_URL;else process.env.SOPHIA_RUNTIME_DATABASE_URL=oldUrl;});
  const original={mode:process.env.XERO_SYNC_EXECUTION_MODE,enabled:process.env.XERO_SYNC_SCHEDULER_ENABLED};
  afterEach(()=>{for(const [key,value] of Object.entries({XERO_SYNC_EXECUTION_MODE:original.mode,XERO_SYNC_SCHEDULER_ENABLED:original.enabled})) {
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }});
  it('does not start an API timer in worker mode even with the old flag enabled',()=>{
    process.env.XERO_SYNC_EXECUTION_MODE='worker';process.env.XERO_SYNC_SCHEDULER_ENABLED='true';
    const scheduler=new StudentOperationsXeroSyncScheduler({} as never,{} as never);
    const tick=jest.spyOn(scheduler,'tick');scheduler.onApplicationBootstrap();
    expect(tick).not.toHaveBeenCalled();scheduler.onModuleDestroy();
  });
  it('claims one durable worker run and prevents overlapping ticks',async()=>{
    process.env.XERO_SYNC_EXECUTION_MODE='worker';
    let release!:()=>void;
    const processRun=jest.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
    const query=jest.fn(async()=>({rows:[{customer_id:'tenant',sync_run_id:'run'}]}));
    const scheduler=new StudentOperationsXeroSyncScheduler({query} as never,{process:processRun} as never);
    const first=scheduler.tick();await Promise.resolve();await scheduler.tick();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('claim_due_student_operations_xero_worker_runs'),[1]);
    release();await first;expect(processRun).toHaveBeenCalledWith('tenant','run');
  });
});
