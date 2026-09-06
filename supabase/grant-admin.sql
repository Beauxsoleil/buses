-- =====================================================================
--  grant-admin.sql — allow one account to edit fleet records
--
--  1. Create the account first: Supabase Dashboard -> Authentication ->
--     Users -> "Add user" (set a password, or use "Send magic link").
--  2. Replace the e-mail address below and run this in the SQL editor.
--  3. Once your account exists, disable public sign-ups:
--     Authentication -> Providers -> Email -> "Allow new users to sign up" OFF.
--
--  Signing in alone grants nothing; only accounts listed in admin_users
--  pass the RLS policies. To revoke access: delete from public.admin_users.
-- =====================================================================

insert into public.admin_users (user_id, email, note)
select id, email, 'Fleet administrator'
  from auth.users
 where lower(email) = lower('you@example.com')
on conflict (user_id) do update set email = excluded.email;

-- Sanity check: lists every current admin.
select a.user_id, a.email, a.added_at, u.last_sign_in_at
  from public.admin_users a
  join auth.users u on u.id = a.user_id
 order by a.added_at;
