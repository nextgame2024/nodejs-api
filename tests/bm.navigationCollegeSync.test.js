import {beforeEach,expect,jest,test} from '@jest/globals';
const list=jest.fn(),access=jest.fn();
jest.unstable_mockModule('../src/models/bm.navigation.links.model.js',()=>({listActiveNavigationLinks:list,hasActiveSophiaAdminEntitlement:jest.fn().mockResolvedValue(false)}));
jest.unstable_mockModule('../src/services/bm.studentUserSync.service.js',()=>({canAccessStudentSync:access}));
jest.unstable_mockModule('../src/services/leads/assistant-settings.service.js',()=>({canAccessAssistant:jest.fn().mockResolvedValue(false)}));
const {listActiveNavigationLinks}=await import('../src/services/bm.navigation.links.service.js');
beforeEach(()=>{list.mockReset();access.mockReset();});
test('existing Chief Executive sync entitlement exposes the sibling college page without migration',async()=>{
  list.mockResolvedValue([{navigationLinkId:'users',navigationType:'menu',navigationLabel:'Sync users'}]);access.mockResolvedValue(true);
  const links=await listActiveNavigationLinks('company','chief',{navigationType:'menu'});
  expect(links.map(l=>l.navigationLabel)).toEqual(['Sync users','Sync colleges']);expect(access).toHaveBeenCalledTimes(1);
});
test('does not expose either sync tool without the server entitlement',async()=>{
  list.mockResolvedValue([{navigationLabel:'Sync users'},{navigationLabel:'Sync colleges'},{navigationLabel:'Company'}]);access.mockResolvedValue(false);
  expect((await listActiveNavigationLinks('company','advisor',{navigationType:'menu'})).map(l=>l.navigationLabel)).toEqual(['Company']);
});
test('does not duplicate an explicitly configured college link',async()=>{
  list.mockResolvedValue([{navigationLabel:'Sync users'},{navigationLabel:'Sync colleges'}]);access.mockResolvedValue(true);
  expect((await listActiveNavigationLinks('company','chief',{navigationType:'menu'})).length).toBe(2);
});
