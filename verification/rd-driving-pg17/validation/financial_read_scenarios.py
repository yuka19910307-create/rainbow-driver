"""Prepared SQL10 read scenarios, outside the unchanged fixed run9 package.

An independently approved future isolated runner must explicitly include SQL10
and this module after SQL01..09, the finance fixture and preceding scenarios.
All identities/payments are synthetic. This is not real Auth/Square evidence.
Importing this module performs no database, subprocess or network operation.
"""
import json,time
import outbox_scenarios as o
import customer_termination_scenarios as c
import history_scenarios as h
import financial_event_scenarios as f

GROUPS=('E-PG-46','E-PG-47','E-PG-48','E-PG-49')
KEYS={'schemaVersion','requestId','caseRevision','readAt','coverage','originalPaymentObservation',
      'recordedRefunds','paymentReviewRecorded','lastNotificationReceivedAt','historicalReference',
      'notificationReceivedAfterFinalization','reviewReasons','operatorDetails'}


def read_sql(m,case,actor='operator',actor_id=None,session=None,aal2=None,token=None,exp=None):
    return o.call('rd_ops_financial_observation_v1',[
        m.booking(case),actor,actor_id or (m.OWNER if actor=='operator' else m.CUSTOMER),
        session or (o.SESSION2 if actor=='operator' else m.CUSTOMER_SESSION),
        actor=='operator' if aal2 is None else aal2,
        (None if actor=='operator' else 'a'*64) if token is None else token,
        m.expiry() if exp is None else exp])


def full_state(r,m,case):
    return {'business':o.state(r,o.envelope(m,case,71000)),
            'financial':f.snapshot(r,m,case),'money':c.financial_snapshot(r,m,case),
            'closures':json.loads(r.sql(f"SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.operation_id),'[]'::jsonb) FROM rd_private.operation_terminal_results x WHERE request_id='{m.booking(case)}';"))}


def value(r,m,case,actor='operator'):
    before=full_state(r,m,case)
    result=json.loads(r.sql(read_sql(m,case,actor)))
    assert full_state(r,m,case)==before,'Read mutated persisted state'
    assert set(result)==KEYS and result['schemaVersion']==1 and result['requestId']==m.booking(case)
    assert type(result['readAt']) is int and result['readAt']>0
    assert result['coverage']=={'source':'local_recorded_observations',
      'originalPayment':'none' if result['originalPaymentObservation'] is None else 'partial',
      'missedEventRecovery':'not_performed','additionalPayments':'not_implemented','currentSettlementConfirmed':False}
    assert set(result['recordedRefunds'])=={'pendingCount','completedCount','failedCount','rejectedCount','completeSetVerified'}
    assert result['recordedRefunds']['completeSetVerified'] is False
    if actor=='customer':assert result['operatorDetails'] is None
    else:
        assert set(result['operatorDetails'])=={'paymentSessionId','environment','originalPaymentId','originalOrderId',
          'recordedNotificationCount','staleNotificationCount','unchangedNotificationCount','recordedDisputeCount'}
        assert result['operatorDetails']['paymentSessionId']==m.payment(case)
    expected=['delivery_completeness_unverified','additional_payments_untracked']
    p=result['originalPaymentObservation']
    if p is None:expected.append('original_payment_unobserved')
    else:
        assert set(p)=={'status','amountYen','cumulativeRefundYen','providerUpdatedAt','receivedAt','source'}
        assert 0<=p['cumulativeRefundYen']<=p['amountYen'] and p['receivedAt']<=result['readAt']
    if result['recordedRefunds']['pendingCount']>0:expected.append('refund_pending_observed')
    if result['paymentReviewRecorded']:expected.append('payment_review_recorded')
    historical=result['historicalReference'];last=result['lastNotificationReceivedAt']
    if historical is None:assert result['notificationReceivedAfterFinalization'] is None
    else:
        assert set(historical)=={'operationId','observedAt','finalizedAt','additionalPaymentRecorded'}
        assert 0<historical['observedAt'] and historical['finalizedAt']<=result['readAt']
        assert historical['finalizedAt']-120000<=historical['observedAt']<=historical['finalizedAt']+5000
        assert result['notificationReceivedAfterFinalization']==(last is not None and last>historical['finalizedAt'])
    if result['notificationReceivedAfterFinalization'] is True:expected.append('notification_after_finalization')
    assert result['reviewReasons']==expected
    return result


def rejected(r,m,cases,sql,error):
    before=[full_state(r,m,case) for case in cases]
    r.sql(sql,expect_error=error)
    assert [full_state(r,m,case) for case in cases]==before


def run(r,coverage,m):
    # The earlier isolated scenario sequence already created/bound SESSION2.
    for case in range(701,708):f.setup(r,m,case,linked=True)
    clock=time.time()-180
    absent=value(r,m,701)
    assert absent['originalPaymentObservation'] is None and absent['lastNotificationReceivedAt'] is None
    assert absent['paymentReviewRecorded'] is False
    assert absent['recordedRefunds']==dict(pendingCount=0,completedCount=0,failedCount=0,rejectedCount=0,completeSetVerified=False)
    customer=value(r,m,701,'customer')
    assert {k:v for k,v in customer.items() if k not in ['readAt','operatorDetails']}=={
      k:v for k,v in absent.items() if k not in ['readAt','operatorDetails']}
    r.sql(f.poll(m,702,f.payment_object(702,clock)))
    polled=value(r,m,702)
    assert polled['originalPaymentObservation']['source']=='provider_poll'
    assert polled['lastNotificationReceivedAt'] is None and polled['operatorDetails']['recordedNotificationCount']==0
    for role in ['anon','authenticated']:
        rejected(r,m,[701],read_sql(m,701).replace('SET ROLE service_role;',f'SET ROLE {role};'),'permission denied')
    for role in ['service_role','anon','authenticated']:
        for table in ['financial_object_heads','financial_event_receipts']:
            rejected(r,m,[701],f'SET ROLE {role}; SELECT * FROM rd_private.{table};','permission denied')
    for args in [{'aal2':False},{'exp':int(time.time())-1},{'actor':'customer','token':'c'*64},
                 {'actor':'customer','actor_id':c.OTHER_CUSTOMER,'session':c.OTHER_SESSION},
                 {'actor':'customer','session':o.SESSION2}]:
        rejected(r,m,[701],read_sql(m,701,**args),'RD_FINANCIAL_READ_AUTH_DENIED')
    coverage.mark('E-PG-46','Read-only owner/customer projections require current original authority; token-only/wrong customer/AAL2/expiry/private-table access rejected; absent and poll-only observations remain explicitly incomplete without invented receipt or zero payment')

    payment=f.payment_object(703,clock,500)
    f.applied(r,m,703,73001,payment)
    for number,status in enumerate(['PENDING','COMPLETED','FAILED','REJECTED'],73002):
        f.applied(r,m,703,number,f.object_event('refund',f'SYNTHETIC_READ_REFUND_{number}',
          'SYNTHETIC_PAY_703',clock+1,status,600),'observed')
    f.applied(r,m,703,73006,f.object_event('dispute','SYNTHETIC_READ_DISPUTE',
      'SYNTHETIC_PAY_703',clock+2,'EVIDENCE_REQUIRED',100,1),'observed')
    f.applied(r,m,703,73007,{**payment,'objectUpdatedAt':f.stamp(clock-1),'eventCreatedAt':f.stamp(clock-1)},'stale')
    f.applied(r,m,703,73008,payment,'unchanged')
    prior=f.snapshot(r,m,703)
    replay=json.loads(r.sql(f.event(73008,payment)));assert replay['replay'] is True
    assert f.snapshot(r,m,703)==prior
    observed=value(r,m,703)
    assert observed['originalPaymentObservation']['cumulativeRefundYen']==500
    assert observed['recordedRefunds']==dict(pendingCount=1,completedCount=1,failedCount=1,rejectedCount=1,completeSetVerified=False)
    assert observed['operatorDetails']['recordedNotificationCount']==8
    assert observed['operatorDetails']['staleNotificationCount']==1 and observed['operatorDetails']['unchangedNotificationCount']==1
    assert observed['operatorDetails']['recordedDisputeCount']==1 and observed['paymentReviewRecorded'] is True
    value(r,m,703,'customer')
    r.sql('UPDATE rd_private.ops_settings SET enabled=false,terminal_terms_enabled=false WHERE id=1;')
    before=full_state(r,m,703)
    value(r,m,703);value(r,m,703,'customer')
    assert full_state(r,m,703)==before
    r.sql('UPDATE rd_private.ops_settings SET enabled=true,terminal_terms_enabled=true WHERE id=1;')
    coverage.mark('E-PG-47','Pending/completed/failed/rejected refund heads and dispute observation remain separate from cumulative payment amount; late/duplicate notifications preserve money; refunded and business-OFF reads retain scope without authorizing writes')

    # Historical audit is made through existing business RPCs, before any new
    # financial notification. It remains byte-for-byte unchanged after events.
    plan,quote=c.make_terms(r,m,704,74000)
    c.save(r,c.decision(r,m,704,74003,plan,quote,False))
    final=c.current(r,m,704,74004,'terminal_finalize',{'planId':m.operation(plan),
      'quoteId':m.operation(quote),'consentId':m.operation(74003),'additionalPaymentId':None})
    target=json.loads(r.sql(o.writer(final,'terminal_target')))
    evidence=h.synthetic_provider_evidence(target)
    # SQL06 explicitly permits this small provider/server clock difference.
    # Read-only projection must not reject a valid historical finalization.
    literal=o.lit(evidence)
    shifted="jsonb_set("+literal+",'{observedAt}',to_jsonb(floor(extract(epoch from clock_timestamp())*1000)::bigint+3000))"
    final_sql=h.finalize_sql(final,evidence)
    assert final_sql.count(literal)==1
    r.sql(final_sql.replace(literal,shifted,1))
    history=f.terminal_history(r,m,704)
    empty_history=value(r,m,704)
    assert empty_history['historicalReference']['operationId']==m.operation(74004)
    assert empty_history['historicalReference']['observedAt']>empty_history['historicalReference']['finalizedAt'], 'Clock-skew fixture did not exercise a future observation'
    assert empty_history['notificationReceivedAfterFinalization'] is False
    while int(time.time()*1000)<=empty_history['historicalReference']['finalizedAt']:time.sleep(0.001)
    f.applied(r,m,704,74005,f.payment_object(704,clock+3,500))
    f.applied(r,m,704,74006,f.object_event('refund','SYNTHETIC_READ_LATE_REFUND',
      'SYNTHETIC_PAY_704',clock+4,'PENDING',100),'observed')
    after=value(r,m,704);value(r,m,704,'customer')
    assert after['historicalReference']==empty_history['historicalReference']
    assert after['notificationReceivedAfterFinalization'] is True
    assert f.terminal_history(r,m,704)==history
    # Corrupt fixture rows only inside transactions that must abort. No
    # application API is given a private-table mutation permission.
    f.applied(r,m,705,75001,f.payment_object(705,clock))
    base=f"BEGIN; UPDATE rd_private.financial_object_heads SET observation=jsonb_set(observation,'{{refundedYen}}','null'::jsonb) WHERE payment_session_id='{m.payment(705)}';"
    rejected(r,m,[705],base+read_sql(m,705),'RD_FINANCIAL_READ_DATA_UNVERIFIED')
    base=f"BEGIN; UPDATE rd_private.financial_object_heads SET payment_id='SYNTHETIC_FOREIGN' WHERE payment_session_id='{m.payment(705)}';"
    rejected(r,m,[705],base+read_sql(m,705),'RD_FINANCIAL_READ_BINDING_UNVERIFIED')
    # The base fixture has a UNIQUE request_id. Remove only this fixture
    # constraint inside the aborting transaction so the RPC's own ambiguous
    # binding guard is reached; rollback must restore the constraint as well.
    base=f"BEGIN; ALTER TABLE public.payment_sessions DROP CONSTRAINT payment_sessions_request_id_key; INSERT INTO public.payment_sessions(id,status,request_id) VALUES('{m.payment(799)}','pending','{m.booking(705)}');"
    rejected(r,m,[705],base+read_sql(m,705),'RD_FINANCIAL_READ_BINDING_UNVERIFIED')
    r.scalar("SELECT count(*) FROM pg_constraint WHERE conrelid='public.payment_sessions'::regclass AND conname='payment_sessions_request_id_key' AND contype='u';",1)
    coverage.mark('E-PG-48','Historic finalization/consent/price audit stays unchanged after notification; customer receives no provider identifiers; malformed/misbound heads and ambiguous sessions fail closed without committing adversarial fixture writes')

    # Both lock orders: event first -> reader observes committed new state;
    # reader first -> event waits and cannot contaminate the in-flight sample.
    lock=r.locker(f.event(76001,f.payment_object(706,clock,500)))
    pending=r.spawn(read_sql(m,706),'financial-read-after-event')
    r.await_blocked('financial-read-after-event');r.release(lock)
    out,_=o.finish_process(r,pending,'financial-read-after-event');sample=json.loads(out)
    assert sample['originalPaymentObservation']['cumulativeRefundYen']==500
    stable=full_state(r,m,706)
    lock=r.locker(read_sql(m,706))
    pending=r.spawn(f.event(76002,f.payment_object(706,clock+1,700)),'financial-event-after-read')
    r.await_blocked('financial-event-after-read')
    # Use plain fixture SELECTs here: a new SHARE reader may queue behind the
    # waiting exclusive writer, so a synchronous second RPC could deadlock the
    # test coordinator while it is responsible for releasing the first reader.
    assert full_state(r,m,706)==stable
    r.release(lock);o.finish_process(r,pending,'financial-event-after-read')
    assert value(r,m,706)['originalPaymentObservation']['cumulativeRefundYen']==700
    # Expiry after entry authorization, while waiting on the later payment lock.
    before=full_state(r,m,707);end=int(time.time())+2
    lock=r.locker(f"SELECT 1 FROM public.payment_sessions WHERE id='{m.payment(707)}' FOR UPDATE;")
    pending=r.spawn(read_sql(m,707,exp=end),'financial-read-expiry-after-payment-lock')
    r.await_blocked('financial-read-expiry-after-payment-lock')
    while time.time()<=end+0.1:time.sleep(0.05)
    r.release(lock)
    o.finish_process(r,pending,'financial-read-expiry-after-payment-lock','RD_FINANCIAL_READ_AUTH_EXPIRED')
    assert full_state(r,m,707)==before
    lock=r.locker(f"UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='{o.SESSION2}';")
    pending=r.spawn(read_sql(m,707),'financial-read-revoked-before-auth')
    r.await_blocked('financial-read-revoked-before-auth');r.release(lock)
    o.finish_process(r,pending,'financial-read-revoked-before-auth','RD_FINANCIAL_READ_AUTH_DENIED')
    r.sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '1 hour' WHERE id='{o.SESSION2}';")
    assert full_state(r,m,707)==before
    coverage.mark('E-PG-49','Actual request/payment/auth lock contention orders reads against events; expiry after payment wait and synthetic Auth revocation deny disclosure; read side never changes persisted business or financial rows')
