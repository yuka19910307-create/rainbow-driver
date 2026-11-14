"""Prepared SQL09 scenarios, unexecuted and outside frozen run8.

All payment/refund/dispute objects are fabricated fixture values. The fixture
embeds the exact historical finalizer; this does not verify a live DB function,
real Square signature/API, actual charge/refund or deployed webhook delivery.
"""
import datetime,hashlib,json,time
import outbox_scenarios as o
import customer_termination_scenarios as c
import history_scenarios as h


def stamp(seconds):
    return datetime.datetime.fromtimestamp(seconds,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def payment_object(case,at,refunded=0,payment_id=None):
    ident=payment_id or f'SYNTHETIC_PAY_{case}'
    return {'kind':'payment','id':ident,'paymentId':ident,'orderId':f'SYNTHETIC_ORDER_{case}',
      'locationId':'SYNTHETIC_LOCATION','status':'COMPLETED','amountYen':4500,'currency':'JPY',
      'refundedYen':refunded,'objectUpdatedAt':stamp(at),'eventCreatedAt':stamp(at),'version':None}


def object_event(kind,ident,payment_id,at,status,amount=500,version=None):
    return {'kind':kind,'id':ident,'paymentId':payment_id,'orderId':None,
      'locationId':'SYNTHETIC_LOCATION','status':status,'amountYen':amount,'currency':'JPY',
      'refundedYen':None,'objectUpdatedAt':stamp(at),'eventCreatedAt':stamp(at),'version':version}


def event(number,value,event_type=None,event_hash=None,environment='sandbox'):
    kind=event_type or value['kind']+'.updated'
    if value['kind']=='dispute' and event_type is None:kind='dispute.state.updated'
    digest=event_hash or hashlib.sha256(json.dumps([kind,value],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return o.call('rd_ops_apply_square_event_v1',[environment,f'SYNTHETIC_EVENT_{number}',kind,digest,value])


def poll(m,case,value,observed_at=None):
    normalized={key:v for key,v in value.items() if key!='eventCreatedAt'}
    call=o.call('rd_ops_finalize_driving_payment_v1',[m.payment(case),'sandbox',normalized,
        int(time.time()*1000) if observed_at is None else observed_at])
    # Retain named TABLE output instead of relying on psql column delimiters.
    return call.replace('SELECT public.','SELECT row_to_json(x) FROM public.',1)[:-1]+' x;'


def setup(r,m,case,origin=True,linked=False):
    payload={'customer_name':'架空顧客','customer_phone':'00000000000','pickup_address':'架空出発地',
      'destination_address':'架空目的地','pickup_distance_km':3,'trip_distance_km':8,
      'pickup_eta_min':10,'trip_eta_min':20,'pickup_fee':1000,'trip_fee':3500,'total_fee':4500}
    r.sql(f"""INSERT INTO public.payment_sessions(id,status,square_payment_id,square_order_id,request_payload)
      VALUES('{m.payment(case)}','pending',NULL,'SYNTHETIC_ORDER_{case}',{o.lit(payload)});""")
    if origin:r.sql(m.origin_sql(case))
    if linked:
        # Fixture only: a known driving reservation, without faking a provider call.
        r.sql(f"""BEGIN;{m.fixture_payment_context(case)}
          INSERT INTO public.requests(id,status,customer_token_hash,pickup_address,destination_address)
          VALUES('{m.booking(case)}','driving',repeat('a',64),'架空出発地','架空目的地');
          UPDATE public.payment_sessions SET status='paid',request_id='{m.booking(case)}',square_payment_id='SYNTHETIC_PAY_{case}'
            WHERE id='{m.payment(case)}';
          {m.fixture_payment_context_end(case)}COMMIT;""")
    r.scalar('SELECT count(*) FROM rd_private.financial_write_context;',0)


def snapshot(r,m,case):
    return json.loads(r.sql(f"""SELECT jsonb_build_object(
      'session',(SELECT to_jsonb(x) FROM public.payment_sessions x WHERE id='{m.payment(case)}'),
      'request',(SELECT to_jsonb(x) FROM public.requests x JOIN public.payment_sessions s ON s.request_id=x.id WHERE s.id='{m.payment(case)}'),
      'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.event_id),'[]'::jsonb) FROM rd_private.financial_event_receipts e WHERE e.payment_session_id='{m.payment(case)}'),
      'heads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.object_kind,h.object_id),'[]'::jsonb) FROM rd_private.financial_object_heads h WHERE h.payment_session_id='{m.payment(case)}'),
      'requestCount',(SELECT count(*) FROM public.requests),
      'enrolledCount',(SELECT count(*) FROM rd_private.case_head),
      'writeContextCount',(SELECT count(*) FROM rd_private.financial_write_context));"""))


def applied(r,m,case,number,value,outcome='applied'):
    result=json.loads(r.sql(event(number,value)))
    assert set(result)=={'scope','environment','eventId','eventHash','requestId','paymentSessionId','replay','createdNew','outcome','needsReview'}
    assert result['scope']=='driving' and result['environment']=='sandbox'
    assert result['eventId']==f'SYNTHETIC_EVENT_{number}' and result['paymentSessionId']==m.payment(case)
    assert result['replay'] is False and result['needsReview'] is True and result['outcome']==outcome
    r.scalar('SELECT count(*) FROM rd_private.financial_write_context;',0)
    return result


def rejected(r,m,cases,sql,error):
    prior=[snapshot(r,m,case) for case in cases]
    r.sql(sql,expect_error=error)
    assert [snapshot(r,m,case) for case in cases]==prior


def terminal_history(r,m,case):
    e=o.envelope(m,case,49999)
    state=o.state(r,e)
    state['private'].pop('financial_event_receipts',None)
    return state


def run(r,coverage,m):
    clock=time.time()-180
    for case in range(601,609):setup(r,m,case)
    setup(r,m,609,linked=True);setup(r,m,610,origin=False)
    # Confirm a provider-poll object cannot silently hide refunded_money.
    p601=payment_object(601,clock)
    rejected(r,m,[601],poll(m,601,{**p601,'refundedYen':1}),'RD_PAYMENT_CONFIRMATION_UNVERIFIED')
    rejected(r,m,[601],poll(m,601,p601,observed_at=int(time.time()*1000)-121000),'RD_PAYMENT_CONFIRMATION_UNVERIFIED')
    first=json.loads(r.sql(poll(m,601,p601)))
    assert first['request_id'] is not None and first['created_new'] is True
    state=snapshot(r,m,601);assert state['session']['request_id']==first['request_id']
    assert state['session']['square_payment_id']=='SYNTHETIC_PAY_601' and state['session']['status']=='paid'
    r.scalar(f"SELECT count(*) FROM rd_private.case_head WHERE request_id='{first['request_id']}';",1)
    repeated=json.loads(r.sql(poll(m,601,p601)))
    assert repeated=={'request_id':first['request_id'],'created_new':False}
    assert snapshot(r,m,601)['requestCount']==state['requestCount']
    second=applied(r,m,602,4201,payment_object(602,clock))
    assert second['createdNew'] is True and second['requestId'] is not None
    r.scalar(f"SELECT count(*) FROM rd_private.case_head WHERE request_id='{second['requestId']}';",1)
    # The independent scope reader routes legacy away before normalization.
    # A driving RPC may not downgrade to a legacy writer if scope disappears.
    legacy_before=snapshot(r,m,610)
    legacy=json.loads(r.sql(o.call('rd_ops_square_scope_v1',['sandbox',m.payment(610),None,None])))
    assert legacy=={'scope':'legacy','environment':'sandbox','paymentSessionId':m.payment(610)}
    assert snapshot(r,m,610)==legacy_before
    rejected(r,m,[610],event(4202,payment_object(610,clock)),'RD_FINANCIAL_SCOPE_CHANGED')
    rejected(r,m,[610],poll(m,610,payment_object(610,clock)),'RD_FINANCIAL_SCOPE_CHANGED')
    member=json.loads(r.sql(o.call('rd_ops_square_scope_v1',['sandbox',m.payment(602),None,None])))
    assert member=={'scope':'driving','environment':'sandbox','paymentSessionId':m.payment(602)}
    for role in ['anon','authenticated']:
        rejected(r,m,[602],event(4203,payment_object(602,clock+1)).replace('SET ROLE service_role;',f'SET ROLE {role};'),'permission denied')
    # The old direct finalizer must roll back its INSERT if SQL09 denies its later financial write.
    direct=o.call('finalize_paid_payment_session',[m.payment(606),'SYNTHETIC_PAY_606'])
    rejected(r,m,[606],direct,'RD_FINANCIAL_LEGACY_WRITE_DENIED')
    rejected(r,m,[602],f"UPDATE public.payment_sessions SET refunded_amount=1 WHERE id='{m.payment(602)}';",'RD_FINANCIAL_LEGACY_WRITE_DENIED')
    # Failure after the real historical finalizer returned rolls back the booking,
    # its original-customer enrollment, payment binding, object head and receipt.
    r.sql("""CREATE FUNCTION public.rd_fixture_fail_financial_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'RD_FIXTURE_RECEIPT_FAILURE'; END $$;
      CREATE TRIGGER rd_fixture_fail_financial_receipt BEFORE INSERT ON rd_private.financial_event_receipts
      FOR EACH ROW EXECUTE FUNCTION public.rd_fixture_fail_financial_receipt();""")
    rejected(r,m,[607],event(4204,payment_object(607,clock)),'RD_FIXTURE_RECEIPT_FAILURE')
    r.sql('DROP TRIGGER rd_fixture_fail_financial_receipt ON rd_private.financial_event_receipts; DROP FUNCTION public.rd_fixture_fail_financial_receipt();')
    # A recent provider observation can expire during a real SQL lock wait.
    # Start near the boundary so this does not require a two-minute fixture sleep.
    before_wait=snapshot(r,m,608)
    lock=r.locker(f"SELECT 1 FROM public.payment_sessions WHERE id='{m.payment(608)}' FOR UPDATE;")
    observed=int(time.time()*1000)-115000
    pending=r.spawn(poll(m,608,payment_object(608,clock),observed),'financial-poll-freshness-after-lock')
    r.await_blocked('financial-poll-freshness-after-lock')
    while time.time()<=(observed+120000)/1000+0.1:time.sleep(0.05)
    r.release(lock)
    o.finish_process(r,pending,'financial-poll-freshness-after-lock','RD_PAYMENT_CONFIRMATION_UNVERIFIED')
    assert snapshot(r,m,608)==before_wait
    coverage.mark('E-PG-42','Synthetic provider-poll and webhook RPCs call the exact historical finalizer atomically; unscoped legacy remains unchanged; denied roles/legacy writers and post-finalizer receipt failure cannot leave booking/payment/origin effects')

    partial=payment_object(601,clock+20,1000)
    receipt=applied(r,m,601,4300,partial)
    current=snapshot(r,m,601)
    assert current['session']['status']=='partially_refunded' and current['session']['refunded_amount']==1000
    replay=json.loads(r.sql(event(4300,partial)))
    assert replay=={**receipt,'replay':True} and snapshot(r,m,601)==current
    rejected(r,m,[601],event(4300,partial,event_hash='f'*64),'RD_FINANCIAL_EVENT_ID_CONFLICT')
    rejected(r,m,[601],event(4301,{**partial,'refundedYen':500}),'RD_FINANCIAL_SAME_VERSION_CONFLICT')
    rejected(r,m,[601],event(4302,payment_object(601,clock+30,500)),'RD_FINANCIAL_REFUND_AMOUNT_REGRESSION')
    rejected(r,m,[601],event(4303,payment_object(601,time.time()+3600,1000)),'RD_FINANCIAL_EVENT_TIME_INVALID')
    rejected(r,m,[601],event(4304,{**partial,'unexpected':True}),'RD_FINANCIAL_EVENT_INVALID')
    prior=snapshot(r,m,601)
    applied(r,m,601,4305,payment_object(601,clock+10,0),'stale')
    after=snapshot(r,m,601)
    assert after['session']==prior['session'] and after['heads']==prior['heads'] and after['request']==prior['request']
    same={**partial,'eventCreatedAt':stamp(clock+21)}
    applied(r,m,601,4306,same,'unchanged')
    stable=snapshot(r,m,601)
    assert stable['session']==after['session'] and stable['heads']==after['heads']
    rejected(r,m,[601],"DELETE FROM rd_private.financial_event_receipts WHERE event_id='SYNTHETIC_EVENT_4300';",'RD_FINANCIAL_EVENT_IMMUTABLE')
    coverage.mark('E-PG-43','Exact event replay is stable; same-ID/hash/version conflicts, future dates and refund regressions reject with unchanged state; stale/unchanged events retain current money and object head while recording delivery')

    # Create a terminal audit using the existing operation/consent RPCs and a
    # clearly fabricated server observation. No provider payment is performed.
    plan,quote=c.make_terms(r,m,609,40000)
    c.save(r,c.decision(r,m,609,40003,plan,quote,False))
    final=c.current(r,m,609,40004,'terminal_finalize',{'planId':m.operation(plan),
        'quoteId':m.operation(quote),'consentId':m.operation(40003),'additionalPaymentId':None})
    target=json.loads(r.sql(o.writer(final,'terminal_target')))
    evidence=h.synthetic_provider_evidence(target)
    assert evidence['netRetainedYen']==4500 and evidence['additionalPaidYen']==0
    r.sql(h.finalize_sql(final,evidence));o.terminal_result(r,final,'committed')
    history=terminal_history(r,m,609);summary=h.base_snapshot(r,m,609)['terminalFinalization']
    assert summary['finalChargeYen']==4500
    applied(r,m,609,4400,payment_object(609,clock+40,500))
    assert terminal_history(r,m,609)==history and h.base_snapshot(r,m,609)['terminalFinalization']==summary
    financial=snapshot(r,m,609)['session']
    refund=object_event('refund','SYNTHETIC_REFUND_609','SYNTHETIC_PAY_609',clock+41,'COMPLETED',600)
    applied(r,m,609,4401,refund,'observed')
    assert snapshot(r,m,609)['session']==financial
    rejected(r,m,[609],event(4402,{**refund,'status':'PENDING','objectUpdatedAt':stamp(clock+42),'eventCreatedAt':stamp(clock+42)}),'RD_FINANCIAL_REFUND_STATE_REGRESSION')
    dispute=object_event('dispute','SYNTHETIC_DISPUTE_609','SYNTHETIC_PAY_609',clock+43,'EVIDENCE_REQUIRED',4500,1)
    applied(r,m,609,4403,dispute,'observed')
    advanced={**dispute,'status':'WON','version':2,'objectUpdatedAt':stamp(clock+44),'eventCreatedAt':stamp(clock+44)}
    applied(r,m,609,4404,advanced,'observed')
    applied(r,m,609,4405,dispute,'stale')
    rejected(r,m,[609],event(4406,{**dispute,'version':3}),'RD_FINANCIAL_VERSION_TIME_CONFLICT')
    rejected(r,m,[609],poll(m,609,payment_object(609,clock+45)),'RD_PAYMENT_RECONCILIATION_REQUIRED')
    assert snapshot(r,m,609)['session']==financial
    assert terminal_history(r,m,609)==history and h.base_snapshot(r,m,609)['terminalFinalization']==summary
    # A financial event may arrive after the server collected its synthetic
    # provider observation but before finalization obtains the request lock.
    # The event commits independently; the stale finalization must leave no
    # receipt, financial evidence, status change or alteration of customer consent.
    for case,base,kind in [(611,41000,'refund'),(612,42000,'dispute')]:
        setup(r,m,case,linked=True)
        plan,quote=c.make_terms(r,m,case,base)
        c.save(r,c.decision(r,m,case,base+3,plan,quote,False))
        pending_final=c.current(r,m,case,base+4,'terminal_finalize',{'planId':m.operation(plan),
          'quoteId':m.operation(quote),'consentId':m.operation(base+3),'additionalPaymentId':None})
        observed_target=json.loads(r.sql(o.writer(pending_final,'terminal_target')))
        stale_evidence=h.synthetic_provider_evidence(observed_target)
        prior_history=terminal_history(r,m,case);prior_money=c.financial_snapshot(r,m,case)
        notification=object_event(kind,f'SYNTHETIC_LATE_{kind.upper()}_{case}',f'SYNTHETIC_PAY_{case}',
          clock+50,'PENDING' if kind=='refund' else 'EVIDENCE_REQUIRED',100,1 if kind=='dispute' else None)
        event_number=4410+(case-611);label=f'terminal-{kind}-event-after-observation'
        lock=r.locker(event(event_number,notification))
        blocked=r.spawn(h.finalize_sql(pending_final,stale_evidence),label)
        r.await_blocked(label);r.release(lock)
        o.finish_process(r,blocked,label,'RD_TERMINAL_FINANCIAL_RECONCILIATION_REQUIRED')
        assert terminal_history(r,m,case)==prior_history
        assert c.financial_snapshot(r,m,case)==prior_money
        o.counts(r,pending_final,0,0)
        assert h.base_snapshot(r,m,case)['terminalFinalization'] is None
        for table in ['terminal_finalization_audit','terminal_financial_evidence']:
            r.scalar(f"SELECT count(*) FROM rd_private.{table} WHERE operation_id='{pending_final['operationId']}';",0)
        r.scalar(f"SELECT count(*) FROM rd_private.financial_event_receipts WHERE event_id='SYNTHETIC_EVENT_{event_number}';",1)
    coverage.mark('E-PG-44','Refund/dispute observations never replace cumulative money or historical terminal audit; after-observation events win actual request locks and reject stale finalization atomically without changing consent, receipt, status or financial evidence')

    # Order and object fences must serialize competing first payment identities.
    value=payment_object(603,clock+60);lock=r.locker(event(4500,value))
    competing=payment_object(603,clock+61,payment_id='SYNTHETIC_OTHER_PAY_603')
    pending=r.spawn(event(4501,competing),'financial-null-payment-binding-race')
    r.await_blocked('financial-null-payment-binding-race');r.release(lock)
    o.finish_process(r,pending,'financial-null-payment-binding-race','RD_FINANCIAL_PAYMENT_ID_MISMATCH')
    state=snapshot(r,m,603)
    assert state['session']['square_payment_id']=='SYNTHETIC_PAY_603' and state['session']['request_id'] is not None
    assert [x['event_id'] for x in state['events']]==['SYNTHETIC_EVENT_4500']
    rejected(r,m,[603],event(4501,competing),'RD_FINANCIAL_PAYMENT_ID_MISMATCH')
    # One provider object cannot bind to two different payment sessions, even
    # when neither session has a prior object head and their orders differ.
    shared='SYNTHETIC_SHARED_PAYMENT'
    lock=r.locker(event(4502,payment_object(604,clock+62,payment_id=shared)))
    pending=r.spawn(event(4503,payment_object(605,clock+63,payment_id=shared)),'financial-object-cross-session-race')
    r.await_blocked('financial-object-cross-session-race');r.release(lock)
    o.finish_process(r,pending,'financial-object-cross-session-race','RD_FINANCIAL_OBJECT_BINDING_MISMATCH')
    assert snapshot(r,m,604)['session']['square_payment_id']==shared
    untouched=snapshot(r,m,605)
    assert untouched['session']['square_payment_id'] is None and untouched['session']['request_id'] is None
    assert untouched['events']==[] and untouched['heads']==[]
    # Concurrent exact duplicate event returns the one committed receipt.
    state=snapshot(r,m,603)
    lock=r.locker(event(4500,value));pending=r.spawn(event(4500,value),'financial-same-event-replay')
    r.await_blocked('financial-same-event-replay');r.release(lock)
    output,_=o.finish_process(r,pending,'financial-same-event-replay')
    assert json.loads(output)['replay'] is True
    assert snapshot(r,m,603)==state
    shared_refund=object_event('refund','SYNTHETIC_SHARED_REFUND','SYNTHETIC_PAY_601',clock+64,'PENDING',100)
    lock=r.locker(event(4504,shared_refund))
    pending=r.spawn(event(4505,{**shared_refund,'paymentId':'SYNTHETIC_PAY_602'}),'financial-refund-cross-session-race')
    r.await_blocked('financial-refund-cross-session-race');r.release(lock)
    o.finish_process(r,pending,'financial-refund-cross-session-race','RD_FINANCIAL_OBJECT_BINDING_MISMATCH')
    r.scalar("SELECT count(*) FROM rd_private.financial_event_receipts WHERE event_id='SYNTHETIC_EVENT_4505';",0)
    r.scalar('SELECT count(*) FROM rd_private.financial_write_context;',0)
    r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    coverage.mark('E-PG-45','Actual order/object/event lock waits serialize null first-payment, cross-session payment/refund binding and duplicate delivery; losing identities leave no binding/receipt, and all private write contexts are empty')
