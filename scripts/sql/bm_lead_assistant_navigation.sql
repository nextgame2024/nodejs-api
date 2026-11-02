-- Apply as owner after Runtime migration 116. Visibility is filtered by the
-- server settings authorization; a menu row does not grant data access.
INSERT INTO public.bm_navigation_links(navigation_link_id,company_id,user_id,navigation_type,navigation_label,active)
SELECT gen_random_uuid(),b.company_id,NULL,'menu','Leads & Conversations',true
FROM public.bm_company b
WHERE b.status='active' AND EXISTS(SELECT 1 FROM sophia_runtime.customers c WHERE c.external_company_id=b.company_id::text AND c.status='active')
AND NOT EXISTS(SELECT 1 FROM public.bm_navigation_links n WHERE n.company_id=b.company_id AND n.navigation_type='menu' AND n.navigation_label='Leads & Conversations')
ON CONFLICT DO NOTHING;
