import {afterEach,expect,jest,test} from '@jest/globals';
const pingDb=jest.fn().mockResolvedValue(undefined),prior=process.env.RENDER_GIT_COMMIT;
jest.unstable_mockModule('../src/config/db.js',()=>({pingDb}));
const {default:router}=await import('../src/routes/health.routes.js');
const handler=router.stack.find(layer=>layer.route?.path==='/healthz').route.stack[0].handle;
afterEach(()=>{if(prior===undefined)delete process.env.RENDER_GIT_COMMIT;else process.env.RENDER_GIT_COMMIT=prior;});
test('reports the deployed revision with the existing database health check',async()=>{
  process.env.RENDER_GIT_COMMIT='1234567890abcdef1234567890abcdef12345678';const res={json:jest.fn()};
  await handler({},res);expect(res.json).toHaveBeenCalledWith({ok:true,revision:'1234567890ab'});
});
test('keeps local health usable when no deployment revision is configured',async()=>{
  delete process.env.RENDER_GIT_COMMIT;const res={json:jest.fn()};await handler({},res);expect(res.json).toHaveBeenCalledWith({ok:true,revision:null});
});
