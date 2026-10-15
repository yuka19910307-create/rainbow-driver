-- Read-only production inventory. No PII, keys, DDL, intake changes or mail.
-- Expected project: kvoaorzdewwirqryeizq. Check project selection before running.
select jsonb_build_object(
 'intake_control',(select jsonb_build_object(
   'enabled',intake_enabled,'captcha_required',captcha_required,
   'contact_verification_required',contact_verification_required)
  from public.cargo_intake_control where id=1),
 'dependencies',jsonb_build_object(
   'operator_table',to_regclass('public.cargo_operator_accounts') is not null,
   'rate_table',to_regclass('public.cargo_intake_rate_buckets') is not null,
   'rate_function',exists(select 1 from pg_proc where pronamespace='public'::regnamespace
    and proname='cargo_intake_rate_hit')),
 'customer_tables',(select jsonb_agg(jsonb_build_object('name',x.name,
    'present',to_regclass('public.'||x.name) is not null))
  from (values ('cargo_customer_intake_drafts'),('cargo_customer_intake_requests'),
   ('cargo_customer_quote_replies'),('cargo_customer_quote_followups'),
   ('cargo_customer_quote_followup_events'),('cargo_customer_retention_runs'),
   ('cargo_customer_mail_budget')) x(name)),
 'customer_routines',(select coalesce(jsonb_agg(jsonb_build_object(
   'name',proname,'security_definer',prosecdef)),'[]'::jsonb)
  from pg_proc where pronamespace='public'::regnamespace and proname like 'cargo_customer_%')
) as cargo_release_inventory;
