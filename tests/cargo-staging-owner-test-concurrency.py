# Disposable GitHub Actions PostgreSQL only. No Supabase credentials or connections.
import subprocess

def sql(s):
 return subprocess.check_output(['docker','exec','-i','cargo-otp-ci-postgres','psql','-X','-At','-U','postgres','-v','ON_ERROR_STOP=1','-c',s],text=True).strip()
o='5ccbfcd5-bd0f-4a9a-b570-223b3deb2567';d='33333333-3333-4333-8333-333333333333';r='44444444-4444-4444-8444-444444444444'
sql(f"insert into auth.users(id) values('{o}') on conflict do nothing; insert into public.cargo_staging_owner_test_runs(owner_id,draft_id,expires_at,enabled) values('{o}','{d}',clock_timestamp()+interval '20 minutes',true)")
for action,target in [('start',d),('quote_send',r)]:
 if action=='quote_send':
  sql(f"insert into public.cargo_customer_intake_requests(id,source_draft_id,contact_hmac,encrypted_payload) values('{r}','{d}',decode(repeat('ab',32),'hex'),decode(repeat('ab',30),'hex'))")
 command=['docker','exec','-i','cargo-otp-ci-postgres','psql','-X','-At','-U','postgres','-v','ON_ERROR_STOP=1','-c',f"select public.cargo_staging_owner_test_authorize('{o}','{action}','{target}',true)->>'ok'"]
 procs=[subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
 results=[]
 for p in procs:
  out,err=p.communicate(timeout=20)
  assert p.returncode==0,err
  results.append(out.strip())
 assert sorted(results)==['false','true'],(action,results)
print('PASS: simultaneous start and quote claims each grant exactly one attempt.')
