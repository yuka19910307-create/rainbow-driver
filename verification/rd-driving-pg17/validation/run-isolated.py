#!/usr/bin/env python3
"""Prepared only. No SQL or PostgreSQL invocation occurs without --execute gate.
Creates an entirely NEW PostgreSQL cluster. Never accepts a DB URL/hostname.
"""
import argparse, datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from pg_plan import FILES, SQL_FILES, GATES, MARKER, REQUIRED_SCENARIOS, Coverage, plan, verify_manifest, bundle, object_contract, catalog_assertions
import outbox_scenarios

ROOT = pathlib.Path(__file__).resolve().parent.parent
OWNER = '22222222-2222-4222-8222-222222222222'
SESSION = '33333333-3333-4333-8333-333333333333'
CUSTOMER = '77777777-7777-4777-8777-777777777777'
CUSTOMER_SESSION = '88888888-8888-4888-8888-888888888888'
HASH = 'b' * 64
APPROVAL = 'APPROVED-SYNTHETIC-LOCAL-SQL-ONLY'
APPROVED_INPUTS = None

def input_text(name):
    if APPROVED_INPUTS is not None:return APPROVED_INPUTS[name].decode()
    return (ROOT/name).read_text()

def candidate(index):
    text=input_text(SQL_FILES[index])
    if text.count(GATES[index])!=1:
        raise RuntimeError('Review marker differs: stop and reapprove extraction')
    return text.replace(GATES[index],MARKER,1)


def booking(n): return '11111111-1111-4111-8111-' + str(n).zfill(12)
def payment(n): return '55555555-5555-4555-8555-' + str(n).zfill(12)
def operation(n): return '66666666-6666-4666-8666-' + str(n).zfill(12)
def literal(v): return "'" + v.replace("'", "''") + "'"
def expiry(): return int(time.time()) + 1800

def submit(case, op, revision=0, action='wait_start', payload=None, exp=None):
    if payload is None: payload = {'kind':'stop','notified':True}
    return "SET ROLE service_role;\nSELECT public.rd_ops_submit_v1(%s,%s,%s,true,%s,%d,%s,%s,%s::jsonb,%d);" % (
        literal(booking(case)), literal(OWNER), literal(SESSION), literal(operation(op)), revision,
        literal(HASH), literal(action), literal(json.dumps(payload, ensure_ascii=False)), exp or expiry())

def origin_sql(case):
    return f"SET ROLE service_role; SELECT public.rd_ops_record_checkout_origin_v1('{payment(case)}','{CUSTOMER}','{CUSTOMER_SESSION}',{expiry()});"

def link_sql(case):
    # Deliberately synthetic finalization sequence, NOT the old finalize RPC.
    # Original saved RPC inserts requests first, then updates paid/request_id.
    # driving status skips unrelated legacy progression to isolate enrollment.
    return f"""BEGIN;
INSERT INTO public.requests(id,status,customer_token_hash,pickup_address,destination_address)
VALUES ('{booking(case)}','driving',repeat('a',64),'架空出発地','架空目的地');
UPDATE public.payment_sessions SET status='paid',request_id='{booking(case)}'
 WHERE id='{payment(case)}';
COMMIT;"""

def enroll_prospective_fixtures(r):
    # No fixture writes to checkout_customer_origins or case_head directly.
    # Only the candidate origin RPC and actual first-paid-link trigger may enroll.
    r.sql("UPDATE rd_private.ops_settings SET identity_intake_enabled=true WHERE id=1;")
    r.sql(origin_sql(7))
    r.sql(link_sql(7)) # ops.enabled is still false: must remain legacy forever
    r.scalar(f"SELECT count(*) FROM rd_private.case_head WHERE request_id='{booking(7)}';",0)
    r.sql("UPDATE rd_private.ops_settings SET enabled=true WHERE id=1;")
    for case in range(1,6):
        r.sql(origin_sql(case))
        r.scalar(f"SELECT count(*) FROM rd_private.case_head WHERE request_id='{booking(case)}';",0)
        r.sql(link_sql(case))
        r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{booking(case)}';",0)
    r.sql(link_sql(8)) # Old tab: deliberately no prospective origin.
    for case in [6,7,8]:
        # Poll/reconciliation/refund metadata must not enroll old or OFF-linked cases.
        r.sql(f"UPDATE public.payment_sessions SET status='partially_refunded' WHERE id='{payment(case)}';")
        r.scalar(f"SELECT count(*) FROM rd_private.case_head WHERE request_id='{booking(case)}';",0)
    r.sql(origin_sql(6),expect_error='RD_CHECKOUT_SESSION_INVALID')
    r.sql(origin_sql(7),expect_error='RD_CHECKOUT_SESSION_INVALID')
    r.sql(origin_sql(8),expect_error='RD_CHECKOUT_SESSION_INVALID')

class Runner:
    def __init__(self, bin_dir, temp, evidence):
        self.bin, self.temp, self.evidence = bin_dir, temp, evidence
        self.data, self.socket = temp/'data', temp/'socket'
        self.socket.mkdir(mode=0o700)
        self.count = 0
        # Do not inherit credentials, proxy, service files or arbitrary PGOPTIONS.
        self.env = {'PATH':str(bin_dir)+':/usr/bin:/bin','HOME':str(temp), 'LANG':'C.UTF-8'}
        self.argv = [str(bin_dir/'psql'),'-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1',
                     '-h',str(self.socket),'-p','55439','-U','rd_fixture_admin','-d','postgres']
        self.started = False
        self.processes = []
    def command(self, args):
        self.count += 1
        path=self.evidence/f'{self.count:03d}-command.txt'
        try:
            result=subprocess.run(args,env=self.env,check=True,text=True,capture_output=True,timeout=30)
            path.write_text(repr(args)+'\n'+result.stdout+result.stderr)
            return result
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as exc:
            path.write_text(repr(args)+'\nFAILED OR TIMED OUT\n'+str(exc.stdout)+str(exc.stderr))
            raise
    def start(self):
        for directory in [self.temp,self.socket]:
            if directory.is_symlink() or directory.stat().st_uid!=os.geteuid() or directory.stat().st_mode&0o077:
                raise RuntimeError('Private temporary directory ownership/permissions mismatch')
        if self.data.exists():raise RuntimeError('Refusing to reuse an existing data directory')
        v = self.command([str(self.bin/'postgres'),'--version']).stdout.strip()
        if not re.search(r'PostgreSQL\) 17\.11(?:\s|$)', v):
            raise RuntimeError('Requires PostgreSQL 17.11 exactly; observed '+v)
        self.command([str(self.bin/'initdb'),'-D',str(self.data),'--username=rd_fixture_admin','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'])
        self.started = True
        self.command([str(self.bin/'pg_ctl'),'-D',str(self.data),'-l',str(self.temp/'postgres.log'),
                      '-o',"-c listen_addresses='' -c unix_socket_directories='"+str(self.socket)+"' -c unix_socket_permissions=0700 -p 55439",'-w','start'])
        assert self.sql("SHOW listen_addresses;").strip() == ''
        assert self.sql("SHOW data_directory;").strip() == str(self.data)
        assert self.sql("SELECT inet_server_addr() IS NULL;").strip() == 't'
        assert self.sql("SHOW server_encoding;").strip() == 'UTF8', 'Server encoding must be UTF8'
        assert self.sql("SHOW client_encoding;").strip() == 'UTF8', 'Client encoding must be UTF8'
        assert self.sql("SELECT char_length('日本語'),octet_length('日本語');").strip() == '3|9', 'Synthetic Japanese text must be 3 characters / 9 bytes'
        (self.evidence/'environment.json').write_text(json.dumps({'version':v,'isolation':'new cluster; TCP disabled; private Unix socket; synthetic only',
            'serverEncoding':'UTF8','clientEncoding':'UTF8','syntheticJapanese':{'characters':3,'bytes':9}},indent=2))
    def sql(self, sql, expect_error=None):
        self.count += 1
        (self.evidence/f'{self.count:03d}.sql').write_text(sql)
        try:
            r = subprocess.run(self.argv,env=self.env,input=sql,text=True,capture_output=True,timeout=30)
        except subprocess.TimeoutExpired as exc:
            (self.evidence/f'{self.count:03d}.out').write_text('TIMEOUT\n'+str(exc.stdout)+str(exc.stderr))
            raise
        (self.evidence/f'{self.count:03d}.out').write_text(r.stdout+r.stderr)
        if expect_error:
            if r.returncode == 0 or expect_error not in r.stderr:
                raise AssertionError('Expected exact rejection '+expect_error+'; observed '+r.stderr)
        elif r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r.stdout.strip()
    def scalar(self, query, expected):
        observed=self.sql(query)
        if observed != str(expected): raise AssertionError(f'{query}: expected {expected}, observed {observed}')
    def spawn(self, sql, label):
        (self.evidence/(label+'.sql')).write_text(sql)
        # -c is one entire transaction-capable request; explicitly qualified local connection.
        p=subprocess.Popen(self.argv+['-c',sql],env={**self.env,'PGAPPNAME':label},text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.processes.append(p)
        return p
    def await_blocked(self, label):
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            if self.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name="+literal(label)+" AND wait_event_type='Lock';")== '1':return
            time.sleep(0.05)
        raise RuntimeError('Expected lock wait was not observed for '+label)
    def locker(self, sql):
        self.count += 1
        (self.evidence/f'{self.count:03d}-locker.sql').write_text('BEGIN;\n'+sql+'\nCOMMIT;')
        p=subprocess.Popen(self.argv,env=self.env,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.processes.append(p)
        # Ignore SELECT result rows from an RPC held open by this transaction.
        # The readiness marker is emitted only after that RPC really returned.
        p.stdin.write('\\o /dev/null\nBEGIN;\n'+sql+'\n\\o\n\\echo LOCKED\n');p.stdin.flush()
        # bounded readiness poll; never infer lock acquisition merely from elapsed time
        import selectors
        sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
        if not sel.select(10): p.kill();raise RuntimeError('locker readiness timed out')
        line=p.stdout.readline().strip();sel.close()
        if line!='LOCKED':p.kill();raise RuntimeError('locker did not acquire lock: '+line)
        return p
    def release(self, p):
        p.stdin.write('COMMIT;\n');p.stdin.close()
        p.wait(timeout=10)
        if p.returncode:raise RuntimeError('locker commit failed: '+p.stderr.read())
    def stop(self):
        for p in self.processes:
            if p.poll() is None:p.kill();p.wait(timeout=10)
        if self.started and (self.data/'postmaster.pid').exists():
            self.command([str(self.bin/'pg_ctl'),'-D',str(self.data),'-m','immediate','-w','stop'])
            self.started=False

def tests(r, coverage):
    enroll_prospective_fixtures(r)
    coverage.mark('E-PG-02','Prospective origin/first-link enrollment; old/OFF cases denied')
    r.sql(f"INSERT INTO rd_private.operator_grants(user_id,enabled,changed_at) VALUES ('{OWNER}',true,clock_timestamp()-interval '1 day');")
    r.sql(f"SET ROLE service_role; SELECT public.rd_ops_bind_owner_session_v1('{OWNER}','{SESSION}',true,{expiry()});")
    # Actual EXECUTE boundary under synthetic non-admin roles.
    for role in ['anon','authenticated']:
        r.sql('SET ROLE '+role+';\n'+submit(5,10).partition('\n')[2],expect_error='permission denied for function rd_ops_submit_v1')
    for role in ['anon','authenticated']:
        r.sql('SET ROLE '+role+'; SELECT * FROM rd_private.case_head;',expect_error='permission denied')
    coverage.mark('E-PG-01','Anonymous/authenticated RPC and private table access rejected')
    # Owner cannot lazily enroll a pre-existing, old-tab or OFF-linked booking.
    for case,reason in [(6,'RD_ORIGINAL_CUSTOMER_NOT_AUTHORIZED'),(7,'RD_CASE_NOT_ENROLLED'),(8,'RD_ORIGINAL_CUSTOMER_NOT_AUTHORIZED')]:
        r.sql(submit(case,100+case),expect_error=reason)
        r.scalar(f"SELECT count(*) FROM rd_private.case_head WHERE request_id='{booking(case)}';",0)
        r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE request_id='{booking(case)}';",0)
    # Entire saved wait/revision/receipt rolls back under explicit rollback;
    # enrollment happened before this operation and must remain revision 0.
    r.sql('BEGIN;\n'+submit(1,1)+'\nROLLBACK;')
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{booking(1)}';",0)
    r.scalar(f"SELECT count(*) FROM rd_private.wait_interval WHERE request_id='{booking(1)}';",0)
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id='{operation(1)}';",0)
    coverage.mark('E-PG-03','Business state, wait and receipt rolled back; prior enrollment preserved')
    # COMMIT accepted response intentionally ignored; NEW psql connection looks up receipt.
    r.sql('BEGIN;\n'+submit(1,1)+'\nCOMMIT;')
    lookup=f"SET ROLE service_role; SELECT public.rd_ops_lookup_v1('{booking(1)}','{OWNER}','{SESSION}',true,'{operation(1)}','{HASH}',{expiry()});"
    receipt=json.loads(r.sql(lookup))
    assert receipt['status']=='committed' and receipt['operationId']==operation(1) and receipt['revision']==1
    coverage.mark('E-PG-04','Discarded writer result; committed receipt recovered over a new connection')
    r.sql(submit(1,1)) # exact retry after COMMIT
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{booking(1)}';",1)
    r.sql(submit(1,2),expect_error='RD_REVISION_CONFLICT')
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id='{operation(2)}';",0)
    coverage.mark('E-PG-05','Same operation retry applies once; stale revision produces no success receipt')
    # Existing legacy writer must not finish unresolved or enhanced cases.
    r.sql(f"UPDATE public.requests SET status='completed' WHERE id='{booking(1)}';",expect_error='RD_OPERATION_HAS_UNRESOLVED_WAIT')
    r.sql(submit(1,3,1,'wait_stop_claim',{'intervalId':operation(1)}))
    r.sql(submit(1,4,2,'wait_confirm',{'intervalId':operation(1),'mode':'waive','reason':'synthetic reason'}))
    r.sql(f"UPDATE public.requests SET status='completed' WHERE id='{booking(1)}';",expect_error='RD_ENHANCED_CASE_REQUIRES_VERIFIED_FINALIZATION')
    coverage.mark('E-PG-07','Old writer cannot finish an enhanced case, including waived wait')
    # Two concurrent writers: same revision, different operation IDs, exactly one commit.
    a=r.spawn(submit(2,5),'revision-a');b=r.spawn(submit(2,6),'revision-b')
    results=[(p.communicate(timeout=30),p.returncode) for p in [a,b]]
    (r.evidence/'concurrent-revision.json').write_text(json.dumps(results))
    assert sum(x[1]==0 for x in results)==1 and sum(x[1]!=0 for x in results)==1
    assert 'RD_REVISION_CONFLICT' in ''.join(x[0][1] for x in results)
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE request_id='{booking(2)}';",1)
    coverage.mark('E-PG-06','Two competing revisions: exactly one commit and one conflict')
    # Expiry while blocked on booking row, not merely an expired token at invocation.
    lock=r.locker(f"DO $$ BEGIN PERFORM 1 FROM public.requests WHERE id='{booking(3)}' FOR UPDATE; END $$;")
    end=int(time.time())+2
    pending=r.spawn(submit(3,7,exp=end),'expires-after-lock')
    r.await_blocked('expires-after-lock')
    while time.time()<=end+0.1:time.sleep(0.1)
    r.release(lock)
    out,err=pending.communicate(timeout=30)
    (r.evidence/'expiry-lock.out').write_text(out+err)
    assert pending.returncode!=0 and 'RD_OWNER_AUTH_DENIED' in err
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id='{operation(7)}';",0)
    coverage.mark('E-PG-08','JWT expires during observed booking lock wait; no receipt')
    # Session not_after can expire even with a still-valid JWT.
    r.sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '3 seconds' WHERE id='{SESSION}';")
    lock=r.locker(f"DO $$ BEGIN PERFORM 1 FROM public.requests WHERE id='{booking(5)}' FOR UPDATE; END $$;")
    session_end=time.time()+3.2
    pending=r.spawn(submit(5,9),'session-expires-after-lock')
    r.await_blocked('session-expires-after-lock')
    while time.time()<session_end:time.sleep(0.1)
    r.release(lock)
    out,err=pending.communicate(timeout=30)
    (r.evidence/'session-expiry-lock.out').write_text(out+err)
    assert pending.returncode!=0 and 'RD_OWNER_AUTH_DENIED' in err
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id='{operation(9)}';",0)
    coverage.mark('E-PG-09','Session expires during observed booking lock wait; no receipt')
    # Reset only this synthetic session to test a distinct revocation order.
    r.sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '1 hour' WHERE id='{SESSION}';")
    # Revoke transaction wins grant-row lock before save; save must reject, no receipt.
    lock=r.locker(f"UPDATE rd_private.operator_grants SET enabled=false WHERE user_id='{OWNER}';")
    pending=r.spawn(submit(4,8),'revoked-before-save')
    r.await_blocked('revoked-before-save')
    r.release(lock)
    out,err=pending.communicate(timeout=30)
    (r.evidence/'revocation-lock.out').write_text(out+err)
    assert pending.returncode!=0 and 'RD_OWNER_AUTH_DENIED' in err
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id='{operation(8)}';",0)
    r.sql(f"SET ROLE service_role; SELECT public.rd_ops_bind_owner_session_v1('{OWNER}','{SESSION}',true,{expiry()});",expect_error='RD_OWNER_BIND_DENIED')
    coverage.mark('E-PG-10','Revoke wins authority lock; save and old-session rebind rejected')

def assert_install_absent(r):
    r.scalar("SELECT count(*) FROM pg_namespace WHERE nspname='rd_private';",0)
    r.scalar("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'rd_ops_%';",0)
    r.scalar("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'rd_ops_%';",0)
    r.scalar("SELECT count(*) FROM public.requests;",1)
    r.scalar("SELECT count(*) FROM public.payment_sessions;",8)

def install_tests(r,coverage):
    r.sql(input_text('validation/fixture.sql'))
    # An error disconnects psql with ON_ERROR_STOP. Uncommitted DDL is rolled
    # back by PG; a fresh connection verifies the complete absence of effects.
    assert_install_absent(r)
    for boundary in range(1,len(SQL_FILES)+1):
        r.sql(bundle(APPROVED_INPUTS,fail_after=boundary),expect_error='RD_INJECTED_BOUNDARY_%d'%boundary)
        assert_install_absent(r)
    coverage.mark('E-PG-12','Failure after each of 7 input boundaries rolled back schema/functions/triggers; fixture rows preserved')
    r.sql(bundle(APPROVED_INPUTS))
    r.sql(catalog_assertions(object_contract([input_text(n) for n in SQL_FILES])))
    coverage.mark('E-PG-11','All 7 SQL inputs applied in one transaction; object/RLS/grant/trigger/switch checks before commit and after commit')

def main():
    global APPROVED_INPUTS
    ap=argparse.ArgumentParser()
    ap.add_argument('--execute',action='store_true')
    ap.add_argument('--owner-approval',default='')
    ap.add_argument('--pg-bin',type=pathlib.Path)
    ap.add_argument('--approved-manifest',type=pathlib.Path)
    ap.add_argument('--manifest-sha256',default='')
    a=ap.parse_args()
    observed,_=plan(ROOT)
    if not a.execute:
        print(json.dumps(observed,indent=2));return
    if a.owner_approval!=APPROVAL:ap.error('Owner approval required. Do not provide flag without actual explicit approval.')
    if not __debug__:ap.error('Optimized Python disables assertions; execution prohibited')
    try:manifest,APPROVED_INPUTS=verify_manifest(ROOT,a.approved_manifest,a.manifest_sha256)
    except (ValueError,OSError,KeyError) as e:ap.error(str(e))
    if os.geteuid()==0:ap.error('initdb requires non-root execution; no privilege workaround is performed')
    if not a.pg_bin or not a.pg_bin.is_absolute():ap.error('explicit absolute --pg-bin required; no environment search')
    if any(k.startswith('PG') for k in os.environ):ap.error('Remove PG connection environment from this dedicated runner; values are not inspected')
    for name in ['postgres','psql','initdb','pg_ctl']:
        if not (a.pg_bin/name).is_file():ap.error('required executable unavailable: '+name)
    evidence=ROOT/'validation'/('results-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ'))
    evidence.mkdir(mode=0o700,exist_ok=False)
    (evidence/'input-sha256.json').write_text(json.dumps(manifest,indent=2))
    (evidence/'RESULT.txt').write_text('INCOMPLETE: execution started; no PASS established.\n')
    coverage=Coverage(evidence)
    temp=pathlib.Path(tempfile.mkdtemp(prefix='rd-isolated-pg-'))
    r=Runner(a.pg_bin,temp,evidence)
    failure=None
    try:
        r.start();install_tests(r,coverage);tests(r,coverage)
        outbox_scenarios.run(r,coverage,sys.modules[__name__])
        coverage.require_complete()
    except BaseException as exc:
        failure=exc
        (evidence/'RESULT.txt').write_text('FAILED / incomplete: '+str(exc)+'\n')
    finally:
        try:
            r.stop()
            if (temp/'postgres.log').exists():shutil.copy2(temp/'postgres.log',evidence/'postgres.log')
            shutil.rmtree(temp) # only this runner-created private temporary cluster
        except BaseException as exc:
            failure=failure or exc
            (evidence/'RESULT.txt').write_text('FAILED / incomplete cleanup: '+str(exc)+'\n')
    if failure is not None:raise failure
    # PASS is written only after every required case AND cleanup succeeded.
    (evidence/'RESULT.txt').write_text('PASS: isolated synthetic PG scenario set only; not hosted Auth, Square, Safari, production or all seven functions.\n')
    print(json.dumps({'status':'PASS_ISOLATED_SYNTHETIC_ONLY','evidenceDirectory':str(evidence),'requiredScenarios':REQUIRED_SCENARIOS}))
if __name__=='__main__':main()
