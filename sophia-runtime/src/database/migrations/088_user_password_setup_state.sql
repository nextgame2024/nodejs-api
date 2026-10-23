-- Owner-only additive migration. Preserve all existing credentials and access.
ALTER TABLE public.users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Keep the legacy-row default false while marking every future account at the
-- database boundary, including Users, Add student and background student sync.
-- This state alone never authorizes login or bypasses password verification.
CREATE FUNCTION public.mark_new_user_password_setup()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.must_change_password := true;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_new_user_password_setup() FROM PUBLIC;
CREATE TRIGGER users_require_password_setup
  BEFORE INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.mark_new_user_password_setup();

COMMENT ON COLUMN public.users.must_change_password IS
  'Password setup/change required. Legacy users default false; new accounts true. Never bypass credential verification. Clear only after verified password setup/change; enforced first-login UX is separate work.';
