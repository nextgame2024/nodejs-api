-- Friendly routes are globally unique because public links do not contain a tenant.
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms ADD COLUMN friendly_slug text;
CREATE UNIQUE INDEX lead_forms_friendly_slug ON __SOPHIA_RUNTIME_SCHEMA__.lead_forms(friendly_slug);
ALTER TABLE __SOPHIA_RUNTIME_SCHEMA__.lead_forms ADD CONSTRAINT lead_forms_friendly_slug_format CHECK(friendly_slug ~ '^[a-z][a-z0-9-]{2,100}$');

-- Only assigns a route within the caller's verified tenant; does not expose other forms.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.assign_lead_form_slug(tenant uuid, form uuid, reserved text[] DEFAULT '{}') RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_slug text; title text; base text; candidate text; suffix integer:=1;
BEGIN
 IF tenant IS DISTINCT FROM NULLIF(current_setting('sophia.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Tenant scope required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(74622142);
 SELECT name,friendly_slug INTO title,current_slug FROM __SOPHIA_RUNTIME_SCHEMA__.lead_forms WHERE customer_id=tenant AND id=form FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF current_slug IS NOT NULL THEN RETURN current_slug; END IF;
 base:=left(trim(both '-' from regexp_replace(lower(translate(title,'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÑñÇç','AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc')),'[^a-z0-9]+','-','g')),70);
 IF base !~ '^[a-z]' OR length(base)<3 THEN base:='form-'||base; END IF;
 candidate:=base;
 WHILE candidate=ANY(reserved) OR EXISTS(SELECT 1 FROM __SOPHIA_RUNTIME_SCHEMA__.lead_forms WHERE friendly_slug=candidate) LOOP
  suffix:=suffix+1; candidate:=base||'-'||suffix::text;
 END LOOP;
 UPDATE __SOPHIA_RUNTIME_SCHEMA__.lead_forms SET friendly_slug=candidate WHERE customer_id=tenant AND id=form;
 RETURN candidate;
END $$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.assign_lead_form_slug(uuid,uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.assign_lead_form_slug(uuid,uuid,text[]) TO sophia_runtime_app;

-- Anonymous routing reveals only the opaque token of an active, published form.
-- All content, calendar and submission access continues through tenant RLS.
CREATE FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_lead_form_slug(slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f.customer_id::text||'.'||p.id::text
 FROM __SOPHIA_RUNTIME_SCHEMA__.lead_forms f
 JOIN __SOPHIA_RUNTIME_SCHEMA__.lead_form_publications p ON p.customer_id=f.customer_id AND p.form_id=f.id AND p.active
 JOIN __SOPHIA_RUNTIME_SCHEMA__.customers c ON c.customer_id=f.customer_id AND c.status='active'
 WHERE f.friendly_slug=slug
$$;
REVOKE ALL ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_lead_form_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.resolve_lead_form_slug(text) TO sophia_runtime_app;
