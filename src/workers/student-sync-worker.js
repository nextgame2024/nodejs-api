// Pure coordinator: adapters own the existing queues, role checks and leases.
// One awaited stage at a time. It never imports APIs, providers or database URLs.
export function createStudentSyncCoordinator({runtime,processUsers,customerIds,now=Date.now,log=()=>{}}) {
  if(!customerIds?.length || customerIds.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('Explicit valid document customer IDs are required.');
  }
  const tenants=[...new Set(customerIds)];
  let invoiceAt=0,usersAt=0,scheduleAt=0,heartbeatAt=0,busy=false,tenantIndex=0;
  const documentAt=new Map();
  const healthAt=new Map();let healthIndex=0;
  const hour=new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Brisbane',hour:'2-digit',hourCycle:'h23'});
  async function stage(name,work) {
    try {return {ok:true,value:await work()};}
    catch {log({event:'student_sync_stage_failed',stage:name});return {ok:false};}
  }
  return {
    async tick(signal) {
      if(busy || signal?.aborted) return 15_000;
      busy=true;
      try {
        if(now()>=invoiceAt) {
          await stage('invoices',()=>runtime.processInvoices());invoiceAt=now()+15_000;
        }
        if(signal?.aborted) return 15_000;
        if(now()>=usersAt) {
          const schedule=now()>=scheduleAt;
          const result=await stage('students',()=>processUsers({schedule,throwOnError:true}));
          if(result.ok && schedule) scheduleAt=now()+60_000;
          usersAt=now()+15_000;
        }
        if(signal?.aborted) return 15_000;
        const localHour=Number(hour.format(new Date(now())));
        let delay=15_000;
        if(localHour>=3 && localHour<6) {
          for(let n=0;n<tenants.length;n++) {
            const tenant=tenants[tenantIndex++%tenants.length];
            if(now()<(documentAt.get(tenant)??0)) continue;
            const result=await stage('documents',()=>runtime.processDocument(tenant));
            const processed=result.ok && result.value===true;
            documentAt.set(tenant,now()+(processed?2_000:60_000));
            if(processed) delay=2_000;
            break;
          }
        }
        if(signal?.aborted) return delay;
        if(typeof runtime.reportHealth==='function') {
          // One local read-only report per tick; rotate tenants fairly. A
          // failed report never prevents the next business-processing tick.
          for(let n=0;n<tenants.length;n++) {
            const tenant=tenants[healthIndex++%tenants.length];
            if(now()<(healthAt.get(tenant)??0)) continue;
            healthAt.set(tenant,now()+5*60_000);
            await stage('health',async()=>{
              const report=await runtime.reportHealth(tenant);
              if(report) log({event:'student_sync_health',...report});
            });
            break;
          }
        }
        if(now()>=heartbeatAt) {
          log({event:'student_sync_heartbeat',documentWindow:localHour>=3 && localHour<6});
          heartbeatAt=now()+5*60_000;
        }
        return delay;
      } finally {busy=false;}
    },
  };
}
// Independent bounded analysis lane: one in-flight provider request, round-robin
// tenant admission, no overnight window and no delay to invoice/student stages.
export function createDocumentAnalysisCoordinator({processOne,customerIds,log=()=>{},failureEvent='student_document_analysis_tick_failed'}) {
  if(!customerIds?.length||customerIds.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))throw new Error('Valid analysis customer IDs required.');
  const tenants=[...new Set(customerIds)];let busy=false,index=0;
  return {async tick(signal){
    if(busy||signal?.aborted)return false;
    busy=true;
    try{return await processOne(tenants[index++%tenants.length]);}
    catch{log({event:failureEvent});return false;}
    finally{busy=false;}
  }};
}
