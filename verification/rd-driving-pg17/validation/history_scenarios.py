"""Prepared history/price/settlement PG scenarios, not execution evidence.

Only an independently approved frozen isolated runner may invoke run(). All
identities, clocks and financial provider records below are synthetic fixtures.
No Square/GoTrue/hosted database or payment request is made by this module.
"""
import json, time
import outbox_scenarios as o
import customer_termination_scenarios as c


def history_sql(m, case, cursor=None, limit=20, actor='operator', actor_id=None,
                session=None, exp=None, token=None):
    return o.call('rd_ops_history_v1', [m.booking(case), actor,
      actor_id or (m.OWNER if actor == 'operator' else m.CUSTOMER),
      session or (o.SESSION2 if actor == 'operator' else m.CUSTOMER_SESSION),
      actor == 'operator', token if token is not None else (None if actor == 'operator' else 'a'*64),
      m.expiry() if exp is None else exp, cursor, limit])


def page(r, m, case, cursor=None, limit=20, **identity):
    value=json.loads(r.sql(history_sql(m, case, cursor, limit, **identity)))
    assert value['schemaVersion']==1 and value['requestId']==m.booking(case)
    assert value['revision']==c.revision(r,m,case)
    assert isinstance(value['items'],list) and len(value['items'])<=limit
    assert value['hasMore'] == (value['nextCursor'] is not None)
    keys=[(x['at'],x['operationId']) for x in value['items']]
    assert keys==sorted(keys,reverse=True) and len(keys)==len(set(keys))
    if value['hasMore']:
        last=value['items'][-1]
        assert value['nextCursor']=={'at':last['at'],'operationId':last['operationId']}
    return value


def all_history(r,m,case,limit=7,**identity):
    cursor=None;items=[];seen=set()
    for _ in range(100):
        result=page(r,m,case,cursor,limit,**identity)
        for item in result['items']:
            assert item['operationId'] not in seen, 'Duplicate history item across page boundary'
            seen.add(item['operationId']);items.append(item)
        if not result['hasMore']:return items
        assert result['nextCursor']!=cursor
        cursor=result['nextCursor']
    raise AssertionError('History pagination did not terminate')


def assert_receipt_item(r,e,item):
    receipt=c.row(r,'operation_receipts','operation_id',e['operationId'])
    assert item['operationId']==e['operationId'] and item['action']==e['action']
    assert item['result']=='committed' and item['actor']==e['actor']
    assert item['actorId']==e['actorId']
    assert item['before']==receipt['before_state'] and item['after']==receipt['after_state']
    assert item['before'] is not None and item['after'] is not None
    assert item['before']!=item['after'], 'Successful change must retain distinct states'
    assert receipt['committed_revision']==receipt['expected_revision']+1


def base_snapshot(r,m,case,actor='operator'):
    return json.loads(r.sql(o.call('rd_ops_snapshot_v1',[m.booking(case),actor,
      m.OWNER if actor=='operator' else m.CUSTOMER,
      o.SESSION2 if actor=='operator' else m.CUSTOMER_SESSION,actor=='operator',
      None if actor=='operator' else 'a'*64,m.expiry()])))


def synthetic_provider_evidence(target,additional_id=None):
    """Fabricates the server-side fixture boundary, never a provider success."""
    return {'requestId':target['requestId'],'planId':target['planId'],
      'quoteId':target['quoteId'],'consentId':target['consentId'],
      'paymentSessionId':target['paymentSessionId'],
      'originalPaymentId':target['paymentId'],'orderId':target['orderId'],
      'environment':target['environment'],'currency':'JPY','revision':target['revision'],
      'originalPaidYen':target['originalPaidYen'],
      'completedRefundYen':target['expectedRefundYen'],
      'additionalPaidYen':target['expectedAdditionalYen'],
      'netRetainedYen':target['finalChargeYen'],'pendingRefund':False,
      'disputesChecked':True,'disputeFound':False,'originalPaymentVerified':True,
      'additionalPaymentVerified':True,'additionalPaymentId':additional_id,
      'observedAt':int(time.time()*1000)}


def finalize_sql(e,evidence):
    return o.call('rd_ops_terminal_finalize_v1',[e['requestId'],e['actorId'],e['sessionId'],True,
      e['operationId'],e['expectedRevision'],e['envelopeHash'],e['action'],e['payload'],e['exp'],evidence])


def route_writer_12km(e):
    quote=o.route_quote(e['payload'])
    quote['route']['legs'][0]['distanceMeters']=12000
    quote['totalDistanceMeters']=12000
    quote['serverQuote'].update(trip_distance_km=12,trip_fee=4500,total_fee=5500)
    quote['rawPreview'].update(trip_fee=4500,total_fee=5500)
    return o.call('rd_ops_route_propose_v1',[e['requestId'],e['actorId'],e['sessionId'],True,e['exp'],
      e['operationId'],e['expectedRevision'],e['envelopeHash'],e['payload'],quote])


def run(r,coverage,m):
    for case in range(401,410):c.setup(r,m,case,'accepted' if case==409 else 'driving')

    # Capture successful writes from both actors through real candidate RPCs.
    # An explicit rollback and exact replay must not invent audit history.
    case=401
    e=c.current(r,m,case,2000,'wait_start',{'kind':'stop','notified':True})
    r.sql(o.direct_evidence(e,'receipt'),expect_error='RD_OPERATION_AUDIT_CAPTURE_REQUIRED')
    o.counts(r,e,0,0);r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    r.sql('BEGIN;\n'+f"SELECT rd_private.capture_operation_before('{e['requestId']}','{e['operationId']}');\n"+
      o.direct_evidence(e,'receipt')+'\nCOMMIT;',expect_error='RD_OPERATION_AUDIT_REVISION_MISMATCH')
    o.counts(r,e,0,0);r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    before=o.state(r,e);r.sql('BEGIN;\n'+o.writer(e)+'\nROLLBACK;')
    assert o.state(r,e)==before and all_history(r,m,case)==[]
    c.save(r,e);committed=[e]
    committed.append(c.save(r,c.current(r,m,case,2001,'wait_stop_claim',{'intervalId':m.operation(2000)})))
    committed.append(c.save(r,c.current(r,m,case,2002,'wait_confirm',{'intervalId':m.operation(2000),'mode':'waive','reason':'synthetic reviewed wait'})))
    committed.append(c.save(r,c.request(r,m,case,2003)))
    committed.append(c.save(r,c.link(r,m,case,2004,2003)))
    items=all_history(r,m,case);assert len(items)==len(committed)
    by_id={x['operationId']:x for x in items}
    for e in committed:assert_receipt_item(r,e,by_id[e['operationId']])
    r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    before=o.state(r,e);r.sql(o.writer(e));assert o.state(r,e)==before
    assert all_history(r,m,case)==items
    for sql in [f"UPDATE rd_private.operation_receipts SET before_state='{{}}'::jsonb WHERE operation_id='{e['operationId']}';",
                f"DELETE FROM rd_private.operation_receipts WHERE operation_id='{e['operationId']}';"]:
        r.sql(sql,expect_error='RD_OPERATION_EVIDENCE_IMMUTABLE')
    closed=c.current(r,m,case,2005,'wait_start',{'kind':'stop','notified':True})
    r.sql(o.close(closed));entry=next(x for x in all_history(r,m,case) if x['operationId']==closed['operationId'])
    assert entry['result']=='not_executed' and entry['evidenceState']=='closure_recorded'
    assert entry['before'] is None and entry['after'] is None
    assert entry['actor']=='operator' and entry['actorId']==m.OWNER
    r.sql(o.close(closed));assert len(all_history(r,m,case))==len(committed)+1
    coverage.mark('E-PG-33','New receipt capture omission/revision mismatch fail closed and roll back; RPC receipts retain before/after and both actors; replay/rollback do not duplicate history; closed IDs have no business execution/state')

    # Fixture-only historical receipts deliberately share one millisecond but
    # differ in microseconds, in reverse UUID order. No real business operation
    # or pre-migration backfill is claimed by these raw administrative rows.
    case=402
    fixture_sql=['BEGIN;','ALTER TABLE rd_private.operation_receipts DISABLE TRIGGER rd_ops_receipt_audit_trg;']
    for i in range(31):
        op=m.operation(2100+i)
        fixture_sql.append(f"""INSERT INTO rd_private.operation_receipts
          (operation_id,request_id,actor_id,action,envelope_hash,expected_revision,body,committed_revision,accepted_at)
          VALUES ('{op}','{m.booking(case)}','{m.OWNER}','wait_start',repeat('b',64),0,
          '{{"kind":"stop","notified":true}}',1,
          '2020-01-01 00:00:00+00'::timestamptz + interval '{900-i*20} microseconds');""")
    fixture_sql.extend(['ALTER TABLE rd_private.operation_receipts ENABLE TRIGGER rd_ops_receipt_audit_trg;','COMMIT;'])
    r.sql('\n'.join(fixture_sql))
    first=page(r,m,case,limit=7);assert first['hasMore']
    original={m.operation(i) for i in range(2100,2131)}
    assert [x['operationId'] for x in first['items']]==sorted(original,reverse=True)[:7]
    assert len({x['at'] for x in first['items']})==1
    for item in first['items']:
        assert item['before'] is None and item['after'] is None
        assert item['evidenceState']=='legacy_unavailable'
    newer=c.current(r,m,case,2131,'wait_start',{'kind':'stop','notified':True})
    r.sql(o.close(newer))
    found={x['operationId'] for x in first['items']};cursor=first['nextCursor']
    while cursor is not None:
        result=page(r,m,case,cursor,7)
        ids={x['operationId'] for x in result['items']}
        assert not found.intersection(ids);found.update(ids);cursor=result['nextCursor']
    assert found==original
    refreshed=all_history(r,m,case)
    assert {x['operationId'] for x in refreshed}==original|{newer['operationId']}
    assert refreshed[0]['operationId']==newer['operationId']
    coverage.mark('E-PG-34','Millisecond+UUID descending pagination survives tied microseconds and a newer page-boundary insertion without duplicate/lost historical IDs; legacy states stay explicitly unknown')

    case=401;e=closed;before=o.state(r,e)
    operator_items=all_history(r,m,case)
    customer_items=[{**item,'actorId':None} for item in operator_items]
    assert all_history(r,m,case,actor='customer')==customer_items
    for identity in [
      {'actor':'customer','actor_id':c.OTHER_CUSTOMER,'session':c.OTHER_SESSION},
      {'actor':'customer','session':c.OTHER_SESSION},
      {'actor':'customer','exp':int(time.time())-1},
      {'actor':'customer','token':'c'*64},
      {'actor':'operator','session':m.SESSION},
      {'actor':'operator','exp':int(time.time())-1},
    ]:
        r.sql(history_sql(m,case,**identity),expect_error='RD_HISTORY_AUTH_DENIED')
    for invalid in [{}, {'at':-1,'operationId':m.operation(2000)},
                    {'at':1,'operationId':'not-a-uuid'},
                    {'at':1,'operationId':m.operation(2000),'extra':True}]:
        r.sql(history_sql(m,case,cursor=invalid),expect_error='RD_HISTORY_CURSOR_INVALID')
    r.sql(history_sql(m,case,cursor=first['nextCursor']),expect_error='RD_HISTORY_CURSOR_INVALID')
    for limit in [0,51]:r.sql(history_sql(m,case,limit=limit),expect_error='RD_HISTORY_LIMIT_INVALID')
    r.sql('UPDATE rd_private.ops_settings SET enabled=false,terminal_terms_enabled=false WHERE id=1;')
    for actor,expected in [('operator',operator_items),('customer',customer_items)]:
        assert all_history(r,m,case,actor=actor)==expected
    r.sql('UPDATE rd_private.ops_settings SET enabled=true,terminal_terms_enabled=true WHERE id=1;')
    assert o.state(r,e)==before
    # A synthetic valid JWT expiring while waiting for the booking lock must
    # not return a page merely because it was valid at invocation time.
    exp=int(time.time())+2
    lock=r.locker(f"DO $$ BEGIN PERFORM 1 FROM public.requests WHERE id='{m.booking(case)}' FOR UPDATE; END $$;")
    pending=r.spawn(history_sql(m,case,exp=exp),'history-expiry-after-booking-lock')
    r.await_blocked('history-expiry-after-booking-lock')
    while time.time()<=exp+0.1:time.sleep(0.1)
    r.release(lock);o.finish_process(r,pending,'history-expiry-after-booking-lock','RD_HISTORY_AUTH_DENIED')
    assert o.state(r,e)==before
    coverage.mark('E-PG-35','History requires current original-customer/operator authority, rejects malformed cursors/limits and expiry after actual lock wait; flags-OFF reads preserve all business rows')

    case=403
    first=c.route_proposal(r,m,case,2200,'最初の架空新経路')
    r.sql(route_writer_12km(first));o.terminal_result(r,first,'committed')
    first_row=c.row(r,'route_proposals','proposal_id',first['operationId'])
    comparison=first_row['price_comparison']
    assert comparison['scope']=='route_excluding_wait' and comparison['evidenceState']=='recorded'
    assert comparison['before']['version']=='booking:'+m.booking(case)
    assert comparison['before']['amountYen']==4500 and comparison['after']['amountYen']==5500
    assert comparison['after']['version']=='route:'+first['operationId'] and comparison['deltaYen']==1000
    assert comparison['before']['basis'] and comparison['after']['basis']
    c.save(r,c.route_present(r,m,case,2201,2200));c.save(r,c.route_consent(r,m,case,2202,2200))
    second=c.save(r,c.route_proposal(r,m,case,2203,'二番目の架空新経路'))
    second_row=c.row(r,'route_proposals','proposal_id',second['operationId'])
    assert second_row['price_comparison']['before']['version']=='route:'+first['operationId']
    assert second_row['price_comparison']['before']['amountYen']==5500
    assert second_row['price_comparison']['after']['amountYen']==4500
    assert second_row['price_comparison']['deltaYen']==-1000
    assert c.row(r,'route_proposals','proposal_id',first['operationId'])['price_comparison']==comparison
    r.sql(f"UPDATE rd_private.route_proposals SET price_comparison='{{}}' WHERE proposal_id='{first['operationId']}';",expect_error='RD_ROUTE_PRICE_HISTORY_IMMUTABLE')
    for item in all_history(r,m,case):
        if item['action']=='route_propose':
            assert item['priceComparison']==c.row(r,'route_proposals','proposal_id',item['operationId'])['price_comparison']

    case=404;plan_id,quote_id=c.make_terms(r,m,case,2300)
    old=c.row(r,'terminal_terms','quote_id',m.operation(quote_id))
    assert old['price_comparison']=={'scope':'terminal_total','before':None,
      'after':{'version':'terminal:'+m.operation(quote_id),'amountYen':4500,
      'basis':'original booked fare, no actual-distance claim'},'deltaYen':None,'evidenceState':'before_unavailable'}
    c.save(r,c.decision(r,m,case,2303,plan_id,quote_id,True))
    c.save(r,c.withdraw(r,m,case,2304,plan_id));c.save(r,c.request(r,m,case,2305))
    c.save(r,c.link(r,m,case,2306,2305));c.save(r,c.quote(r,m,case,2307,2306,4300))
    replacement=c.row(r,'terminal_terms','quote_id',m.operation(2307))['price_comparison']
    assert replacement['before']['version']=='terminal:'+m.operation(quote_id)
    assert replacement['before']['amountYen']==4500
    assert old['basis'] in replacement['before']['basis']
    assert replacement['after']['amountYen']==4300 and replacement['deltaYen']==-200
    assert replacement['evidenceState']=='recorded'
    assert c.row(r,'terminal_terms','quote_id',m.operation(quote_id))['price_comparison']==old['price_comparison']
    r.sql(f"UPDATE rd_private.terminal_terms SET price_comparison='{{}}' WHERE quote_id='{m.operation(quote_id)}';",expect_error='RD_TERMINAL_PRICE_HISTORY_IMMUTABLE')
    for item in all_history(r,m,case):
        if item['action']=='terminal_quote':
            assert item['priceComparison']==c.row(r,'terminal_terms','quote_id',item['operationId'])['price_comparison']
    coverage.mark('E-PG-36','Immutable route and terminal versions retain exact before/after amounts, delta and calculation basis across acceptance/decline/withdraw/requote; missing initial total stays explicitly unknown')

    # Exercise finalization using a synthetic server-side financial observation.
    # The timestamp fixture is not a measured 16-minute wait, and these paid /
    # refund amounts are not evidence of a real provider payment or refund.
    for case,base,kind,status in [(408,2500,'early_end','completed'),(409,2520,'cancel','cancelled')]:
        if kind=='cancel':
            c.save(r,c.current(r,m,case,base,'status_transition',{'nextStatus':'en_route'}))
            c.save(r,c.current(r,m,case,base+1,'status_transition',{'nextStatus':'arrived'}))
        start=c.current(r,m,case,base+2,'wait_start',{'kind':'stop','notified':True});c.save(r,start)
        r.sql(f"UPDATE rd_private.wait_interval SET started_at=clock_timestamp()-interval '16 minutes' WHERE interval_id='{start['operationId']}';")
        c.save(r,c.current(r,m,case,base+3,'wait_stop_claim',{'intervalId':start['operationId']}))
        c.save(r,c.current(r,m,case,base+4,'wait_confirm',{'intervalId':start['operationId'],'mode':'confirm','reason':'synthetic elapsed-time fixture'}))
        assert base_snapshot(r,m,case)['wait']['confirmedFeeYen']==1000
        assert base_snapshot(r,m,case)['terminalFinalization'] is None
        c.save(r,c.request(r,m,case,base+5,kind));c.save(r,c.link(r,m,case,base+6,base+5))
        c.save(r,c.current(r,m,case,base+7,'terminal_quote',{
          'policyVersion':'rd-terminal-owner-case-quote-v1','planId':m.operation(base+6),
          'reason':'synthetic terminal review','basis':'original fare plus synthetic confirmed waiting fee',
          'adjustmentYen':0,'finalChargeYen':5500}))
        c.save(r,c.decision(r,m,case,base+8,base+6,base+7,False,5500))
        final=c.current(r,m,case,base+9,'terminal_finalize',{'planId':m.operation(base+6),
          'quoteId':m.operation(base+7),'consentId':m.operation(base+8),
          'additionalPaymentId':'SYNTHETIC_ADDITIONAL_'+str(case)})
        target=json.loads(r.sql(o.writer(final,'terminal_target')))
        evidence=synthetic_provider_evidence(target,final['payload']['additionalPaymentId'])
        assert target['expectedAdditionalYen']==1000 and len(evidence)==21
        before=o.state(r,final)
        r.sql(finalize_sql(final,{**evidence,'netRetainedYen':5501}),expect_error='RD_TERMINAL_PROVIDER_EVIDENCE_INVALID')
        assert o.state(r,final)==before and base_snapshot(r,m,case)['terminalFinalization'] is None
        r.sql('BEGIN;\n'+finalize_sql(final,evidence)+'\nROLLBACK;')
        assert o.state(r,final)==before and base_snapshot(r,m,case)['terminalFinalization'] is None
        o.counts(r,final,0,0)
        r.sql(finalize_sql(final,evidence));o.terminal_result(r,final,'committed')
        snapshot=base_snapshot(r,m,case);summary=snapshot['terminalFinalization']
        assert snapshot['status']==status
        for key,expected in {'operationId':final['operationId'],'planId':m.operation(base+6),
          'quoteId':m.operation(base+7),'consentId':m.operation(base+8),
          'revision':final['expectedRevision']+1,'finalChargeYen':5500,'originalPaidYen':4500,
          'refundCompletedYen':0,'additionalPaidYen':1000,'netRetainedYen':5500}.items():
            assert summary[key]==expected,(key,summary)
        assert summary['finalizedAt']>=summary['observedAt']-5000
        assert c.row(r,'termination_plans','plan_id',m.operation(base+6))['state']=='finalized'
        after=o.state(r,final);r.sql(finalize_sql(final,evidence));assert o.state(r,final)==after
        r.sql('UPDATE rd_private.ops_settings SET enabled=false,terminal_terms_enabled=false WHERE id=1;')
        for actor in ['operator','customer']:
            assert base_snapshot(r,m,case,actor)['terminalFinalization']==summary
        r.sql('UPDATE rd_private.ops_settings SET enabled=true,terminal_terms_enabled=true WHERE id=1;')
        # Protected evidence cannot be silently rewritten/deleted. A controlled
        # fixture corruption below is rolled back on the reader's exact error.
        for table in ['terminal_financial_evidence','terminal_finalization_audit']:
            r.sql(f"DELETE FROM rd_private.{table} WHERE operation_id='{final['operationId']}';",expect_error='RD_OPERATION_EVIDENCE_IMMUTABLE')
        r.sql(f"""BEGIN;
          ALTER TABLE rd_private.terminal_financial_evidence DISABLE TRIGGER rd_terminal_financial_immutable_trg;
          DELETE FROM rd_private.terminal_financial_evidence WHERE operation_id='{final['operationId']}';
          SELECT rd_private.terminal_finalization_summary('{m.booking(case)}');
          ROLLBACK;""",expect_error='RD_TERMINAL_FINALIZATION_EVIDENCE_INCONSISTENT')
        assert o.state(r,final)==after
        assert base_snapshot(r,m,case)['terminalFinalization']==summary
    # An older completed booking, without terminal audit, must still not gain
    # verified settlement evidence merely from its terminal booking status.
    r.sql(f"UPDATE public.requests SET status='completed' WHERE id='{m.booking(6)}';")
    assert base_snapshot(r,m,6)['terminalFinalization'] is None
    r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    coverage.mark('E-PG-37','Synthetic cancel/early-end finalization atomically retains exact verified financial snapshot with flags OFF; rollback/replay stable, incomplete or mutated evidence rejected, terminal status alone proves no settlement')
