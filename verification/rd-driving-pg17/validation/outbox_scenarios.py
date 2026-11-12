"""Prepared E-PG-16..24 scenarios; only invoked by approved isolated runner.
No network provider is called. These are database concurrency tests, not a
simulation of successful Auth/Square operation. Expected SQL07 is mandatory.
"""
import hashlib, json, time, uuid

SESSION2='33333333-3333-4333-8333-333333333334'
CLOSED='RD_OPERATION_CLOSED_UNEXECUTED'
REUSED='RD_OPERATION_ID_REUSED'


def lit(value):
    if value is None:return 'NULL'
    if isinstance(value,bool):return 'true' if value else 'false'
    if isinstance(value,int):return str(value)
    if isinstance(value,(dict,list)):return "'"+json.dumps(value,ensure_ascii=False).replace("'","''")+"'::jsonb"
    return "'"+value.replace("'","''")+"'"

def call(name,args):return 'SET ROLE service_role; SELECT public.'+name+'('+','.join(lit(v) for v in args)+');'

def envelope(m,case,op,revision=0,action='wait_start',payload=None,actor='operator'):
    return {'requestId':m.booking(case),'operationId':m.operation(op),'expectedRevision':revision,
      'envelopeHash':m.HASH,'action':action,'payload':payload if payload is not None else {'kind':'stop','notified':True},
      'actor':actor,'actorId':m.OWNER if actor=='operator' else m.CUSTOMER,
      'sessionId':SESSION2 if actor=='operator' else m.CUSTOMER_SESSION,'exp':m.expiry()}

def args(e):
    return [e['requestId'],e['actor'],e['actorId'],e['sessionId'],e['actor']=='operator',
      None if e['actor']=='operator' else 'a'*64,e['exp'],e['operationId'],e['expectedRevision'],
      e['envelopeHash'],e['action'],e['payload']]

def close(e):return call('rd_ops_close_unexecuted_v1',args(e)+[True])
def lookup(e):return call('rd_ops_operation_result_v1',args(e))

def writer(e,variant=None):
    q=e['requestId'];who=e['actorId'];session=e['sessionId'];exp=e['exp'];op=e['operationId']
    rev=e['expectedRevision'];h=e['envelopeHash'];a=e['action'];p=e['payload']
    owner=[q,who,session,True,op,rev,h,a,p,exp]
    customer=[q,who,session,'a'*64,exp,op,rev,h,a,p]
    if variant=='route_preflight':return call('rd_ops_route_preflight_v1',[q,who,session,True,exp,op,rev,h,p])
    if variant=='terminal_target':return call('rd_ops_terminal_target_v1',[q,who,session,True,exp,op,rev,h,p])
    if a in ['status_transition','wait_start','wait_stop_claim','wait_confirm','settlement_approve','complete_request']:
        return call('rd_ops_submit_v1',owner)
    if a=='customer_finish_confirmation':return call('rd_ops_customer_finish_v1',customer)
    if a=='customer_termination_request':return call('rd_ops_customer_termination_request_v1',customer)
    if a=='route_propose':return call('rd_ops_route_propose_v1',[q,who,session,True,exp,op,rev,h,p,route_quote(p)])
    if a=='route_present':return call('rd_ops_route_present_v1',[q,who,session,True,exp,op,rev,h,p])
    if a in ['customer_consent','customer_decline']:return call('rd_ops_route_decide_v1',customer)
    if a in ['cancel_plan','early_end_plan','terminal_withdraw','termination_plan_from_customer']:return call('rd_ops_termination_plan_v1',owner)
    if a=='terminal_quote':return call('rd_ops_terminal_quote_v1',owner)
    if a in ['customer_terminal_consent','customer_terminal_decline']:return call('rd_ops_terminal_consent_v1',customer)
    if a=='terminal_finalize':return call('rd_ops_terminal_finalize_v1',owner+[{}])
    raise AssertionError('Uncovered writer action '+a)

def writer_payloads(m,case):
    ident=m.operation(9000)
    destination=str(uuid.UUID(hashlib.md5((m.booking(case)+':destination').encode()).hexdigest()))
    return [
      ('status_transition',{'nextStatus':'en_route'},'operator'),
      ('wait_start',{'kind':'stop','notified':True},'operator'),
      ('wait_stop_claim',{'intervalId':ident},'operator'),
      ('wait_confirm',{'intervalId':ident,'mode':'waive','reason':'synthetic'},'operator'),
      ('settlement_approve',{'planId':ident,'confirmed':True},'operator'),
      ('complete_request',{'customerConfirmationId':ident},'operator'),
      ('route_propose',{'points':[{'visitId':m.booking(case),'address':'架空出発地'},{'visitId':destination,'address':'架空目的地'}],'reason':'synthetic'},'operator'),
      ('route_present',{'proposalId':ident},'operator'),
      ('customer_consent',{'proposalId':ident,'presentationId':ident,'quotedTotalYen':4500,'consent':True},'customer'),
      ('customer_decline',{'proposalId':ident,'presentationId':ident,'reason':'synthetic'},'customer'),
      ('customer_finish_confirmation',{'confirmed':True,'statement':'synthetic','confirmedWaitFeeYen':0},'customer'),
      ('cancel_plan',{'reason':'synthetic'},'operator'),
      ('early_end_plan',{'reason':'synthetic'},'operator'),
      ('terminal_withdraw',{'planId':ident,'reason':'synthetic'},'operator'),
      ('terminal_quote',{'policyVersion':'rd-terminal-owner-case-quote-v1','planId':ident,'reason':'synthetic','basis':'synthetic','adjustmentYen':0,'finalChargeYen':4500},'operator'),
      ('customer_terminal_consent',{'planId':ident,'quoteId':ident,'confirmed':True,'statement':'synthetic','finalChargeYen':4500},'customer'),
      ('terminal_finalize',{'planId':ident,'quoteId':ident,'consentId':ident,'additionalPaymentId':None},'operator'),
      ('customer_termination_request',{'kind':'early_end','reason':'synthetic customer request','confirmed':True},'customer'),
      ('termination_plan_from_customer',{'customerRequestId':ident,'reason':'synthetic owner review'},'operator'),
      ('customer_terminal_decline',{'planId':ident,'quoteId':ident,'finalChargeYen':4500,'reason':'synthetic decline'},'customer'),
    ]

def route_quote(payload):
    points=[{'id':p['visitId'],'label':p['address']} for p in payload['points']]
    return {'ruleVersion':'rd-square-v46-sum-meters-round100m-20261028',
      'route':{'points':points,'legs':[{'fromId':points[0]['id'],'toId':points[1]['id'],'distanceMeters':8000,'durationSeconds':1200}],
               'pickup':{'distanceMeters':3000,'durationSeconds':600}},
      'totalDistanceMeters':8000,'totalDurationSeconds':1200,
      'serverQuote':{'pickup_distance_km':3,'trip_distance_km':8,'pickup_eta_min':10,'trip_eta_min':20,'pickup_fee':1000,'trip_fee':3500,'total_fee':4500},
      'rawPreview':{'pickup_fee':1000,'trip_fee':3500,'total_fee':4500}}

def fixture(r,m,case):
    r.sql(f"INSERT INTO public.payment_sessions(id,status) VALUES ('{m.payment(case)}','pending');")
    r.sql(m.origin_sql(case));r.sql(m.link_sql(case))
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{m.booking(case)}';",0)

def restore_owner(r,m):
    # Re-enable only the fixture owner; a genuinely NEW fixture session created
    # after generation change is required. Never backdate/rebind the old session.
    r.sql(f"UPDATE rd_private.operator_grants SET enabled=true WHERE user_id='{m.OWNER}';")
    r.sql(f"""INSERT INTO auth.sessions VALUES ('{SESSION2}','{m.OWNER}',
      '44444444-4444-4444-8444-444444444444','aal2',clock_timestamp(),clock_timestamp()+interval '1 hour');""")
    r.sql(call('rd_ops_bind_owner_session_v1',[m.OWNER,SESSION2,True,m.expiry()]))

def state(r,e):
    # Capture all request-scoped private business rows, not only a revision.
    # Table list comes from actual isolated catalog; termination rows count too.
    query="""DO $state$ DECLARE t record; v jsonb:='{}'::jsonb; rows jsonb; BEGIN
      FOR t IN SELECT c.table_schema,c.table_name FROM information_schema.columns c
        WHERE c.table_schema='rd_private' AND c.column_name='request_id'
        AND c.table_name<>'operation_terminal_results' ORDER BY c.table_name LOOP
        EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),''[]''::jsonb) FROM %I.%I x WHERE request_id=$1',t.table_schema,t.table_name)
          INTO rows USING __REQUEST__::uuid;
        v:=v||jsonb_build_object(t.table_name,rows);
      END LOOP;
      PERFORM set_config('rd.fixture_state',v::text,false);
    END $state$; SELECT jsonb_build_object('private',current_setting('rd.fixture_state')::jsonb,
      'request',(SELECT to_jsonb(r) FROM public.requests r WHERE id=__REQUEST__));""".replace('__REQUEST__',lit(e['requestId']))
    return json.loads(r.sql(query))

def terminal_result(r,e,expected='not_executed'):
    result=json.loads(r.sql(lookup(e)))
    assert result['status']==expected,(expected,result)
    for key in ['requestId','operationId','envelopeHash']:
        assert result[key]==e[key],(key,result)
    if expected=='not_executed':
        assert result['action']==e['action'] and result['expectedRevision']==e['expectedRevision']
        assert result['actor']==e['actor'] and result['reason']=='explicit_unexecuted_close'
        assert isinstance(result['closedAt'],(int,float)) and result['closedAt']>0
    return result

def counts(r,e,success,terminal):
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id={lit(e['operationId'])};",success)
    r.scalar(f"SELECT count(*) FROM rd_private.operation_terminal_results WHERE operation_id={lit(e['operationId'])};",terminal)

def direct_evidence(e,kind):
    # Deliberately bypass the RPC only as fixture administrator to test the
    # defense-in-depth INSERT trigger. Never evidence of a real business save.
    if kind=='receipt':
        return "INSERT INTO rd_private.operation_receipts(operation_id,request_id,actor_id,action,envelope_hash,expected_revision,body,committed_revision) VALUES ("+','.join(lit(v) for v in [e['operationId'],e['requestId'],e['actorId'],e['action'],e['envelopeHash'],e['expectedRevision'],e['payload'],1])+');'
    return "INSERT INTO rd_private.operation_terminal_results(operation_id,request_id,actor_kind,closed_by,closed_by_session,action,envelope_hash,expected_revision,body) VALUES ("+','.join(lit(v) for v in [e['operationId'],e['requestId'],e['actor'],e['actorId'],e['sessionId'],e['action'],e['envelopeHash'],e['expectedRevision'],e['payload']])+');'

def finish_process(r,p,label,expected_error=None,timeout=30):
    out,err=p.communicate(timeout=timeout)
    (r.evidence/(label+'.out')).write_text(out+err)
    if expected_error:assert p.returncode!=0 and expected_error in err,(label,p.returncode,err)
    else:assert p.returncode==0,(label,err)
    return out,err

def run(r,coverage,m):
    restore_owner(r,m)
    for case in range(101,113):fixture(r,m,case)
    # Stale revision failure -> explicitly closed -> independent matching lookup.
    e=envelope(m,101,101,revision=99);before=state(r,e)
    r.sql(writer(e),expect_error='RD_REVISION_CONFLICT')
    terminal_result(r,e,'not_found');counts(r,e,0,0)
    r.sql(close(e));terminal_result(r,e);counts(r,e,0,1);assert state(r,e)==before
    coverage.mark('E-PG-16','Rejected stale revision closed explicitly; independent full-identity not_executed lookup; no business mutation')

    # Close transaction holds the shared operation fence first. A delayed writer
    # must actually block; only after COMMIT may it reject the closed ID.
    e=envelope(m,102,102);before=state(r,e)
    lock=r.locker(close(e));pending=r.spawn(writer(e),'terminal-before-writer')
    r.await_blocked('terminal-before-writer');r.release(lock)
    finish_process(r,pending,'terminal-before-writer',CLOSED)
    terminal_result(r,e);counts(r,e,0,1);assert state(r,e)==before
    coverage.mark('E-PG-17','Close wins observed operation lock; delayed writer rejected with no successful receipt or business state change')

    e=envelope(m,103,103)
    lock=r.locker(writer(e));pending=r.spawn(close(e),'writer-before-terminal')
    r.await_blocked('writer-before-terminal');r.release(lock)
    finish_process(r,pending,'writer-before-terminal')
    terminal_result(r,e,'committed');counts(r,e,1,0)
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{e['requestId']}';",1)
    coverage.mark('E-PG-18','Writer wins; close request preserves committed outcome and creates no false terminal record')

    e=envelope(m,104,104);r.sql(close(e)) # discard response deliberately
    first=terminal_result(r,e);before=state(r,e)
    r.sql(close(e));second=terminal_result(r,e)
    assert first==second and state(r,e)==before;counts(r,e,0,1)
    coverage.mark('E-PG-19','Lost close response recovered via separate connection; repeat close leaves identical terminal evidence')

    # A valid identity cannot attach a terminal proof to another envelope.
    for base in [e,envelope(m,103,103)]:
        for patch in [{'requestId':m.booking(105)},{'envelopeHash':'c'*64},{'expectedRevision':1},{'payload':{'kind':'pickup','notified':True}}]:
            forged={**base,**patch}
            r.sql(close(forged),expect_error=REUSED);r.sql(lookup(forged),expect_error=REUSED)
        forged={**base,'actor':'customer','actorId':m.CUSTOMER,'sessionId':m.CUSTOMER_SESSION,
                'action':'customer_finish_confirmation','payload':{'confirmed':True,'statement':'synthetic','confirmedWaitFeeYen':0}}
        r.sql(close(forged),expect_error=REUSED);r.sql(lookup(forged),expect_error=REUSED)
    coverage.mark('E-PG-20','Cross-request/actor/hash/revision/payload proofs rejected against both committed and closed operations')

    # This switch is enabled only inside the disposable synthetic cluster;
    # catalog checks above already required its migration default to be false.
    r.sql('UPDATE rd_private.ops_settings SET terminal_terms_enabled=true WHERE id=1;')
    proof=envelope(m,106,999);before=state(r,proof)
    actions=writer_payloads(m,106)
    for i,(action,payload,actor) in enumerate(actions,200):
        e=envelope(m,106,i,action=action,payload=payload,actor=actor)
        r.sql(close(e));terminal_result(r,e)
        r.sql(writer(e),expect_error=CLOSED);counts(r,e,0,1)
        if action=='route_propose':r.sql(writer(e,'route_preflight'),expect_error=CLOSED)
        if action=='terminal_finalize':r.sql(writer(e,'terminal_target'),expect_error=CLOSED)
    assert state(r,proof)==before
    coverage.mark('E-PG-21','All 20 action writers and both preflights reject exact closed envelopes; complete business snapshot unchanged')

    # Fresh authority is required even for closing an unexecuted operation.
    e=envelope(m,107,107);before=state(r,e)
    expired={**e,'exp':int(time.time())-1}
    r.sql(close(expired),expect_error='RD_OPERATION_RECOVERY_AUTH_DENIED');counts(r,e,0,0)
    # Revocation transaction takes its row lock first; close must wait, then deny.
    lock=r.locker(f"UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='{SESSION2}';")
    pending=r.spawn(close(e),'revoked-before-terminal');r.await_blocked('revoked-before-terminal');r.release(lock)
    finish_process(r,pending,'revoked-before-terminal','RD_OPERATION_RECOVERY_AUTH_DENIED')
    counts(r,e,0,0);assert state(r,e)==before
    r.sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '1 hour' WHERE id='{SESSION2}';")
    expiring={**e,'exp':int(time.time())+2}
    lock=r.locker(f"DO $$ BEGIN PERFORM 1 FROM public.requests WHERE id='{e['requestId']}' FOR UPDATE; END $$;")
    pending=r.spawn(close(expiring),'expiry-before-terminal');r.await_blocked('expiry-before-terminal')
    while time.time()<=expiring['exp']+0.1:time.sleep(0.1)
    r.release(lock);finish_process(r,pending,'expiry-before-terminal','RD_OPERATION_RECOVERY_AUTH_DENIED')
    counts(r,e,0,0);assert state(r,e)==before
    coverage.mark('E-PG-22','Expired token and session revocation during actual lock wait cannot write terminal evidence')

    e=envelope(m,108,108,revision=99);terminal_result(r,e,'not_found');counts(r,e,0,0)
    r.sql(close(e));terminal_result(r,e)
    next_e=envelope(m,108,109);r.sql(writer(next_e));terminal_result(r,next_e,'committed');counts(r,next_e,1,0)
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{e['requestId']}';",1)
    coverage.mark('E-PG-23','not_found is not terminal proof; after matched close a new ID/current revision can commit (browser release is separate)')

    # Same operation ID, different enrolled request: no split success/terminal.
    e=envelope(m,109,110);other={**e,'requestId':m.booking(110)}
    lock=r.locker(close(e));pending=r.spawn(writer(other),'cross-request-same-op')
    r.await_blocked('cross-request-same-op');r.release(lock)
    finish_process(r,pending,'cross-request-same-op',REUSED);counts(r,e,0,1)
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{other['requestId']}';",0)
    # Different operations and different requests must both finish; same request
    # different operations serializes on booking without circular wait.
    for case_pair,op_pair,label in [((111,112),(111,112),'different-request'),((105,105),(113,114),'same-request')]:
        left=envelope(m,case_pair[0],op_pair[0]);right=envelope(m,case_pair[1],op_pair[1])
        a=r.spawn(close(left),label+'-a');b=r.spawn(close(right),label+'-b')
        finish_process(r,a,label+'-a');finish_process(r,b,label+'-b')
        terminal_result(r,left);terminal_result(r,right)
    # Old snapshots cannot defeat receipt-vs-terminal exclusivity: isolation
    # modes outside the explicit READ COMMITTED contract fail closed.
    for i,isolation in enumerate(['REPEATABLE READ','SERIALIZABLE','READ UNCOMMITTED'],115):
        e=envelope(m,112,i)
        for sql in [close(e),lookup(e),writer(e),direct_evidence(e,'receipt'),direct_evidence(e,'terminal')]:
            r.sql('BEGIN ISOLATION LEVEL '+isolation+';\n'+sql+'\nCOMMIT;',expect_error='RD_OPERATION_ISOLATION_UNSUPPORTED')
        counts(r,e,0,0)
    # Direct INSERTs cannot form a cycle while holding a booking lock: the
    # trigger must reject contention immediately, then reject the committed
    # opposite outcome on a separate attempted INSERT.
    for i,first in enumerate(['receipt','terminal'],120):
        e=envelope(m,112,i);second='terminal' if first=='receipt' else 'receipt'
        lock=r.locker(direct_evidence(e,first))
        pending=r.spawn(direct_evidence(e,second),'direct-evidence-'+first)
        finish_process(r,pending,'direct-evidence-'+first,'RD_OPERATION_LOCK_REQUIRED',timeout=5)
        r.release(lock)
        r.sql(direct_evidence(e,second),expect_error='RD_OPERATION_ALREADY_COMMITTED' if first=='receipt' else CLOSED)
        counts(r,e,1 if first=='receipt' else 0,1 if first=='terminal' else 0)
    e=envelope(m,112,122)
    a=r.spawn(close(e),'close-with-bind');b=r.spawn(call('rd_ops_bind_owner_session_v1',[m.OWNER,SESSION2,True,m.expiry()]),'bind-with-close')
    finish_process(r,a,'close-with-bind');finish_process(r,b,'bind-with-close');terminal_result(r,e)
    r.scalar('SELECT count(*) FROM rd_private.operation_receipts r JOIN rd_private.operation_terminal_results t USING(operation_id);',0)
    coverage.mark('E-PG-24','Same-ID/cross-request and same/different-request closures; bind/revocation contention; direct INSERT try-lock rejects both orders; RR/serializable/read-uncommitted writer+trigger denial; no dual evidence')
