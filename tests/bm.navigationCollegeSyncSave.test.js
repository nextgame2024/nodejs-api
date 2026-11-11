import {beforeEach,expect,jest,test} from '@jest/globals';

const sync=jest.fn(),create=jest.fn(),companyExists=jest.fn();
jest.unstable_mockModule('../src/services/bm.navigation.links.service.js',()=>({
  syncNavigationLabels:sync,createNavigationLink:create,companyExists,
}));
const controller=await import('../src/controllers/bm.navigation.links.controller.js');
const actor='c2dad143-077c-4082-92f0-47805601db3b',company='fixture-company';
beforeEach(()=>{sync.mockReset().mockResolvedValue({navigationLinks:[{navigationLabel:'Sync colleges'}]});create.mockReset().mockResolvedValue({navigationLabel:'Sync colleges'});companyExists.mockReset().mockResolvedValue(true);});
async function request(handler,body){
  const res={status:jest.fn().mockReturnThis(),json:jest.fn()},next=jest.fn();
  await handler({user:{id:actor,companyId:company},body},res,next);
  return {res,next};
}
test('accepts Sync colleges in the Navigation links bulk Save request',async()=>{
  const {res,next}=await request(controller.syncNavigationLabels,{navigationLinksSync:{company_id:company,navigation_type:'menu',navigation_labels:['Colleges','Sync users','Sync colleges']}});
  expect(next).not.toHaveBeenCalled();expect(sync).toHaveBeenCalledWith(company,actor,{navigation_type:'menu',navigation_labels:['Colleges','Sync users','Sync colleges']});expect(res.json).toHaveBeenCalled();
});
test('canonicalizes the college menu label for single-link creation',async()=>{
  const {res,next}=await request(controller.createNavigationLink,{navigationLink:{company_id:company,navigation_type:' MENU ',navigation_label:' sync COLLEGES '}});
  expect(next).not.toHaveBeenCalled();expect(create).toHaveBeenCalledWith(company,actor,expect.objectContaining({navigation_type:'menu',navigation_label:'Sync colleges'}));expect(res.status).toHaveBeenCalledWith(201);
});
test('keeps rejecting the college label in header navigation',async()=>{
  const {next}=await request(controller.syncNavigationLabels,{company_id:company,navigation_type:'header',navigation_labels:['Sync colleges']});
  expect(next).toHaveBeenCalledWith(expect.objectContaining({status:400}));expect(sync).not.toHaveBeenCalled();
});
test('keeps rejecting unknown menu labels without persistence',async()=>{
  const {next}=await request(controller.syncNavigationLabels,{company_id:company,navigation_type:'menu',navigation_labels:['Unregistered tool']});
  expect(next).toHaveBeenCalledWith(expect.objectContaining({status:400}));expect(sync).not.toHaveBeenCalled();
});
