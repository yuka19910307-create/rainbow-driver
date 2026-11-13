"""Prepared SQL08 scenarios. Not covered by the successful frozen run8.

Only a separately approved future isolated runner may execute run(). All users,
sessions and timestamps are synthetic; no real Auth/provider is contacted.
"""
import json,time
import outbox_scenarios as o
import customer_termination_scenarios as c


def auth(e):
    return [e['requestId'],e['actor'],e['actorId'],e['sessionId'],e['actor']=='operator',
            None if e['actor']=='operator' else 'a'*64,e['exp']]


def begin(e,attempt):
    return o.call('rd_ops_attempt_begin_v1',auth(e)+[attempt,e['operationId'],
        e['expectedRevision'],e['envelopeHash'],e['action']])


def observe(e,attempt,kind='result_unknown',reason='transport'):
    return o.call('rd_ops_attempt_observe_v1',auth(e)+[attempt,e['operationId'],
        e['expectedRevision'],e['envelopeHash'],e['action'],kind,reason])


def page_sql(e,cursor=None,limit=20):
    return o.call('rd_ops_attempt_page_v1',auth(e)+[cursor,limit])


def admitted(r,e,attempt):
    value=json.loads(r.sql(begin(e,attempt)))
    assert set(value)=={'requestId','operationId','attemptId','registeredAt'}
    for key,want in [('requestId',e['requestId']),('operationId',e['operationId']),('attemptId',attempt)]:
        assert value[key]==want
    assert type(value['registeredAt']) is int and value['registeredAt']>0
    return value


def page(r,e,cursor=None,limit=20):
    value=json.loads(r.sql(page_sql(e,cursor,limit)))
    assert set(value)=={'schemaVersion','requestId','items','hasMore','nextCursor','coverage'}
    assert value['schemaVersion']==1 and value['requestId']==e['requestId']
    assert value['coverage']=='authenticated_submissions_only'
    assert type(value['hasMore']) is bool and value['hasMore']==(value['nextCursor'] is not None)
    assert len(value['items'])<=limit
    keys=[]
    for item in value['items']:
        assert set(item)=={'attemptId','operationId','action','actor','actorId','expectedRevision','registeredAt','observation'}
        assert type(item['registeredAt']) is int and item['registeredAt']>0
        if e['actor']=='customer':assert item['actorId'] is None
        if item['observation'] is not None:
            obs=item['observation'];assert set(obs)=={'kind','reasonCategory','observedAt'}
            assert type(obs['observedAt']) is int and obs['observedAt']>=item['registeredAt']
        keys.append((item['registeredAt'],item['attemptId']))
    assert keys==sorted(keys,reverse=True) and len(keys)==len(set(keys))
    if cursor is not None:
        assert all(key<(cursor['at'],cursor['attemptId']) for key in keys)
        assert value['nextCursor']!=cursor
    if value['hasMore']:
        last=value['items'][-1]
        assert value['nextCursor']=={'at':last['registeredAt'],'attemptId':last['attemptId']}
    return value


def business_state(r,e):
    value=o.state(r,e)
    value['private'].pop('operation_attempts',None)
    return value


def ledger_state(r,request_id):
    return json.loads(r.sql(f"""SELECT jsonb_build_object(
      'admissions',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attempt_id),'[]'::jsonb)
        FROM rd_private.operation_attempts a WHERE a.request_id={o.lit(request_id)}),
      'observations',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.attempt_id),'[]'::jsonb)
        FROM rd_private.operation_attempt_observations v JOIN rd_private.operation_attempts a USING(attempt_id)
        WHERE a.request_id={o.lit(request_id)}));"""))


def counts(r,attempt,admission,observation):
    for table,n in [('operation_attempts',admission),('operation_attempt_observations',observation)]:
        r.scalar(f"SELECT count(*) FROM rd_private.{table} WHERE attempt_id={o.lit(attempt)};",n)


def expire_while_blocked(r,sql,label,end):
    process=r.spawn(sql,label);r.await_blocked(label)
    while time.time()<=end+0.1:time.sleep(0.05)
    return process


def run(r,coverage,m):
    for case in range(501,507):c.setup(r,m,case)
    case=501;e=o.envelope(m,case,30001);attempt=m.operation(80001)
    before=business_state(r,e);money=c.financial_snapshot(r,m,case)
    admission=admitted(r,e,attempt)
    counts(r,attempt,1,0);o.counts(r,e,0,0)
    assert business_state(r,e)==before and c.financial_snapshot(r,m,case)==money
    assert page(r,e)['items'][0]['observation'] is None
    # Admission committed in a separate RPC cannot be erased by business rollback.
    r.sql('BEGIN;\n'+o.writer(e)+'\nROLLBACK;')
    assert business_state(r,e)==before and admitted(r,e,attempt)==admission
    counts(r,attempt,1,0);o.counts(r,e,0,0)
    r.sql('UPDATE rd_private.ops_settings SET enabled=false WHERE id=1;')
    r.sql(o.writer(e),expect_error='RD_OPERATION_DISABLED')
    assert json.loads(r.sql(observe(e,attempt,'response_denied','feature_disabled')))=={'recorded':True}
    recorded=page(r,e)['items'][0]
    assert recorded=={'attemptId':attempt,'operationId':e['operationId'],'action':e['action'],
      'actor':'operator','actorId':m.OWNER,'expectedRevision':0,'registeredAt':admission['registeredAt'],
      'observation':{'kind':'response_denied','reasonCategory':'feature_disabled',
        'observedAt':recorded['observation']['observedAt']}}
    r.sql(observe(e,attempt,'response_denied','feature_disabled'))
    assert page(r,e)['items'][0]==recorded
    r.sql(observe(e,attempt),expect_error='RD_ATTEMPT_OBSERVATION_CONFLICT')
    assert page(r,e)['items'][0]==recorded
    assert business_state(r,e)==before and c.financial_snapshot(r,m,case)==money
    o.terminal_result(r,e,'not_found');o.counts(r,e,0,0)
    # Observe failure is not allowed to manufacture receipt/closure or alter admission.
    second=m.operation(80002);admitted(r,e,second)
    r.sql(observe(e,second,'acknowledged_pending','transport'),expect_error='RD_ATTEMPT_OBSERVATION_INVALID')
    counts(r,second,1,0)
    for table in ['operation_attempts','operation_attempt_observations']:
        r.sql(f"DELETE FROM rd_private.{table} WHERE attempt_id='{attempt}';",expect_error='RD_OPERATION_EVIDENCE_IMMUTABLE')
    r.sql('UPDATE rd_private.ops_settings SET enabled=true WHERE id=1;')
    coverage.mark('E-PG-38','Authenticated admission survives independent business rollback/denial; immutable response observations never become receipt or closure and remain readable with business flags OFF')

    scoped=[e,o.envelope(m,502,30000)]
    untouched=[(business_state(r,x),c.financial_snapshot(r,m,501+i),ledger_state(r,x['requestId']))
               for i,x in enumerate(scoped)]
    for change in [{'requestId':m.booking(502)},{'envelopeHash':'d'*64},
                   {'expectedRevision':1},{'action':'wait_stop_claim'},
                   {'actor':'customer','actorId':m.CUSTOMER,'sessionId':m.CUSTOMER_SESSION,'action':'customer_finish_confirmation'}]:
        forged={**e,**change}
        r.sql(begin(forged,attempt),expect_error='RD_ATTEMPT_ID_REUSED')
        for i,x in enumerate(scoped):
            assert (business_state(r,x),c.financial_snapshot(r,m,501+i),ledger_state(r,x['requestId']))==untouched[i]
        r.sql(observe(forged,attempt),expect_error='RD_ATTEMPT_ID_REUSED')
        for i,x in enumerate(scoped):
            assert (business_state(r,x),c.financial_snapshot(r,m,501+i),ledger_state(r,x['requestId']))==untouched[i]
        r.sql(begin(forged,m.operation(80003)),expect_error='RD_OPERATION_ID_REUSED')
        for i,x in enumerate(scoped):
            assert (business_state(r,x),c.financial_snapshot(r,m,501+i),ledger_state(r,x['requestId']))==untouched[i]
    different_operation={**e,'operationId':m.operation(30999)}
    for query in [begin(different_operation,attempt),observe(different_operation,attempt)]:
        r.sql(query,expect_error='RD_ATTEMPT_ID_REUSED')
        for i,x in enumerate(scoped):
            assert (business_state(r,x),c.financial_snapshot(r,m,501+i),ledger_state(r,x['requestId']))==untouched[i]
    r.sql(begin(e,e['operationId']),expect_error='RD_ATTEMPT_ID_INVALID')
    for role in ['anon','authenticated']:
        r.sql(begin(e,m.operation(80003)).replace('SET ROLE service_role;',f'SET ROLE {role};'),expect_error='permission denied')
        r.sql(observe(e,attempt).replace('SET ROLE service_role;',f'SET ROLE {role};'),expect_error='permission denied')
        r.sql(page_sql(e).replace('SET ROLE service_role;',f'SET ROLE {role};'),expect_error='permission denied')
        r.sql(f'SET ROLE {role}; SELECT * FROM rd_private.operation_attempts;',expect_error='permission denied')
    bad={**e,'sessionId':m.SESSION};r.sql(begin(bad,m.operation(80003)),expect_error='RD_ATTEMPT_AUTH_DENIED')
    customer=o.envelope(m,502,30002,actor='customer',action='customer_termination_request',payload={'kind':'early_end','reason':'synthetic','confirmed':True})
    unrelated={**customer,'actorId':c.OTHER_CUSTOMER,'sessionId':c.OTHER_SESSION}
    r.sql(begin(unrelated,m.operation(80004)),expect_error='RD_ATTEMPT_AUTH_DENIED')
    denied_hash=auth(customer);denied_hash[5]='b'*64
    r.sql(o.call('rd_ops_attempt_begin_v1',denied_hash+[m.operation(80004),customer['operationId'],0,m.HASH,customer['action']]),expect_error='RD_ATTEMPT_AUTH_DENIED')
    counts(r,m.operation(80003),0,0);counts(r,m.operation(80004),0,0)
    # An already authoritative receipt cannot be relabelled by a later admission.
    committed=o.envelope(m,502,30003);c.save(r,committed)
    receipt_before=business_state(r,committed)
    r.sql(begin({**committed,'envelopeHash':'e'*64},m.operation(80005)),expect_error='RD_OPERATION_ID_REUSED')
    admitted(r,committed,m.operation(80005));assert business_state(r,committed)==receipt_before
    o.terminal_result(r,committed,'committed')
    closed=o.envelope(m,503,30004);r.sql(o.close(closed));closure=o.terminal_result(r,closed)
    r.sql(begin({**closed,'expectedRevision':1},m.operation(80006)),expect_error='RD_OPERATION_ID_REUSED')
    admitted(r,closed,m.operation(80006));assert o.terminal_result(r,closed)==closure
    customer_ok=o.envelope(m,506,30005,actor='customer',action='customer_termination_request',
        payload={'kind':'early_end','reason':'synthetic admitted request','confirmed':True})
    before_customer=business_state(r,customer_ok);customer_attempt=m.operation(80007)
    customer_admission=admitted(r,customer_ok,customer_attempt)
    assert json.loads(r.sql(observe(customer_ok,customer_attempt,'acknowledged_pending','none')))=={'recorded':True}
    customer_view=page(r,customer_ok)['items'][0]
    assert customer_view['actor']=='customer' and customer_view['actorId'] is None
    assert customer_view['attemptId']==customer_attempt and customer_view['operationId']==customer_ok['operationId']
    assert customer_view['action']=='customer_termination_request' and customer_view['expectedRevision']==0
    assert customer_view['registeredAt']==customer_admission['registeredAt']
    assert customer_view['observation']['kind']=='acknowledged_pending' and customer_view['observation']['reasonCategory']=='none'
    owner_reader={**customer_ok,'actor':'operator','actorId':m.OWNER,'sessionId':o.SESSION2}
    owner_view=page(r,owner_reader)['items'][0]
    assert owner_view=={**customer_view,'actorId':m.CUSTOMER}
    assert business_state(r,customer_ok)==before_customer;o.counts(r,customer_ok,0,0)
    coverage.mark('E-PG-39','Attempt IDs and operation identities reject cross-booking/actor/hash/revision/action reuse; original customer/session and private permissions enforced; existing receipt/closure remain authoritative')

    race=o.envelope(m,504,30010);a1=m.operation(80010);a2=m.operation(80011)
    lock=r.locker(begin(race,a1));pending=r.spawn(begin(race,a2),'attempt-same-operation-distinct-http')
    r.await_blocked('attempt-same-operation-distinct-http');r.release(lock)
    o.finish_process(r,pending,'attempt-same-operation-distinct-http')
    counts(r,a1,1,0);counts(r,a2,1,0);o.counts(r,race,0,0)
    lock=r.locker(begin(race,a1));pending=r.spawn(begin(race,a1),'attempt-same-id-replay')
    r.await_blocked('attempt-same-id-replay');r.release(lock)
    output,_=o.finish_process(r,pending,'attempt-same-id-replay')
    assert json.loads(output)==admitted(r,race,a1)
    end=int(time.time())+2;expired={**race,'operationId':m.operation(30011),'exp':end}
    lock=r.locker(f"SELECT 1 FROM public.requests WHERE id='{race['requestId']}' FOR UPDATE;")
    pending=expire_while_blocked(r,begin(expired,m.operation(80012)),'attempt-admission-expiry-after-lock',end)
    r.release(lock);o.finish_process(r,pending,'attempt-admission-expiry-after-lock','RD_ATTEMPT_AUTH_DENIED');counts(r,m.operation(80012),0,0)
    end=int(time.time())+2;expired={**race,'exp':end}
    lock=r.locker(f"SELECT 1 FROM public.requests WHERE id='{race['requestId']}' FOR UPDATE;")
    pending=expire_while_blocked(r,observe(expired,a1),'attempt-observation-expiry-after-lock',end)
    r.release(lock);o.finish_process(r,pending,'attempt-observation-expiry-after-lock','RD_ATTEMPT_AUTH_DENIED');counts(r,a1,1,0)
    lock=r.locker(f"UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='{o.SESSION2}';")
    pending=r.spawn(begin({**race,'operationId':m.operation(30012)},m.operation(80013)),'attempt-revocation-before-admission')
    r.await_blocked('attempt-revocation-before-admission');r.release(lock)
    o.finish_process(r,pending,'attempt-revocation-before-admission','RD_ATTEMPT_AUTH_DENIED');counts(r,m.operation(80013),0,0)
    r.sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '1 hour' WHERE id='{o.SESSION2}';")
    lock=r.locker(observe(race,a1,'acknowledged_pending','none'))
    pending=r.spawn(observe(race,a1),'attempt-competing-observations')
    r.await_blocked('attempt-competing-observations');r.release(lock)
    o.finish_process(r,pending,'attempt-competing-observations','RD_ATTEMPT_OBSERVATION_CONFLICT')
    first_observation=ledger_state(r,race['requestId'])
    assert next(x for x in first_observation['observations'] if x['attempt_id']==a1)['kind']=='acknowledged_pending'
    r.sql(observe(race,a1,'acknowledged_pending','none'))
    assert ledger_state(r,race['requestId'])==first_observation
    o.counts(r,race,0,0)
    coverage.mark('E-PG-40','Distinct attempts for one operation serialize without business execution; exact same-attempt replay stable; actual booking/authority lock waits recheck token expiry and synthetic revocation before admission/observation')

    case=505;reader=o.envelope(m,case,30020);ids=[m.operation(80100+i) for i in range(7)]
    for attempt_id in ids:admitted(r,reader,attempt_id)
    # Explicit synthetic tie fixture, not a claim of measured same-millisecond arrivals.
    tied=int(time.time()*1000)-10000
    r.sql(f"""BEGIN;
      ALTER TABLE rd_private.operation_attempts DISABLE TRIGGER rd_attempt_immutable_trg;
      UPDATE rd_private.operation_attempts SET registered_at={tied} WHERE request_id='{reader['requestId']}';
      ALTER TABLE rd_private.operation_attempts ENABLE TRIGGER rd_attempt_immutable_trg;
      COMMIT;""")
    first=page(r,reader,limit=3);assert [x['attemptId'] for x in first['items']]==sorted(ids,reverse=True)[:3]
    newer=m.operation(80120);admitted(r,reader,newer)
    values=list(first['items']);cursor=first['nextCursor']
    for _ in range(20):
        if cursor is None:break
        part=page(r,reader,cursor,3);values+=part['items'];cursor=part['nextCursor']
    else:raise AssertionError('Attempt pagination did not terminate')
    assert [x['attemptId'] for x in values]==sorted(ids,reverse=True)
    assert newer not in {x['attemptId'] for x in values}
    customer_reader={**reader,'actor':'customer','actorId':m.CUSTOMER,'sessionId':m.CUSTOMER_SESSION}
    assert all(x['actorId'] is None for x in page(r,customer_reader)['items'])
    foreign=page(r,race)['items'][0]
    for cursor in [[],{}, {'at':-1,'attemptId':ids[0]}, {'at':tied,'attemptId':'invalid'},
                   {'at':tied,'attemptId':ids[0],'extra':True},
                   {'at':foreign['registeredAt'],'attemptId':foreign['attemptId']}]:
        r.sql(page_sql(reader,cursor),expect_error='RD_ATTEMPT_CURSOR_INVALID')
    for limit in [0,51,None]:r.sql(page_sql(reader,limit=limit),expect_error='RD_ATTEMPT_LIMIT_INVALID')
    end=int(time.time())+2;expired={**reader,'exp':end}
    lock=r.locker(f"SELECT 1 FROM public.requests WHERE id='{reader['requestId']}' FOR UPDATE;")
    pending=expire_while_blocked(r,page_sql(expired),'attempt-page-expiry-after-lock',end)
    r.release(lock);o.finish_process(r,pending,'attempt-page-expiry-after-lock','RD_ATTEMPT_AUTH_DENIED')
    state=business_state(r,reader);visible_before_off=page(r,reader)['items']
    r.sql('UPDATE rd_private.ops_settings SET enabled=false,terminal_terms_enabled=false WHERE id=1;')
    assert page(r,reader)['items']==visible_before_off
    assert all(x['actorId'] is None for x in page(r,customer_reader)['items'])
    assert business_state(r,reader)==state
    r.sql('UPDATE rd_private.ops_settings SET enabled=true,terminal_terms_enabled=true WHERE id=1;')
    r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    coverage.mark('E-PG-41','Attempt pagination is bounded and stable across tied timestamps/newer insertion; cursor scope, role projection and post-lock expiry checked; flags-OFF reads neither clear pending operations nor manufacture outcomes')
