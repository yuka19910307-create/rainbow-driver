"""Unexecuted PG scenarios for customer intent and terminal price refusal.
These tests must receive their own new manifest/approval. Fixed run3 does NOT
cover this module. No provider, actual-distance acquisition or payment occurs.
"""
import json, time
import outbox_scenarios as o

OTHER_CUSTOMER='77777777-7777-4777-8777-777777777778'
OTHER_SESSION='88888888-8888-4888-8888-888888888889'


def revision(r,m,case):
    return int(r.sql(f"SELECT revision FROM rd_private.case_head WHERE request_id='{m.booking(case)}';"))

def current(r,m,case,op,action,payload,actor='operator'):
    return o.envelope(m,case,op,revision(r,m,case),action,payload,actor)

def save(r,e):
    r.sql(o.writer(e));result=o.terminal_result(r,e,'committed')
    assert result['revision']==e['expectedRevision']+1
    return e

def request(r,m,case,op,kind='early_end'):
    return current(r,m,case,op,'customer_termination_request',{'kind':kind,'reason':'synthetic stop request','confirmed':True},'customer')

def link(r,m,case,op,request_op):
    return current(r,m,case,op,'termination_plan_from_customer',{'customerRequestId':m.operation(request_op),'reason':'synthetic review'})

def withdraw(r,m,case,op,plan_op):
    return current(r,m,case,op,'terminal_withdraw',{'planId':m.operation(plan_op),'reason':'synthetic withdraw/requote'})

def quote(r,m,case,op,plan_op,amount=4500):
    return current(r,m,case,op,'terminal_quote',{'policyVersion':'rd-terminal-owner-case-quote-v1','planId':m.operation(plan_op),
      'reason':'synthetic terms','basis':'original booked fare, no actual-distance claim','adjustmentYen':amount-4500,'finalChargeYen':amount})

def decision(r,m,case,op,plan_op,quote_op,decline,amount=4500):
    payload={'planId':m.operation(plan_op),'quoteId':m.operation(quote_op),'finalChargeYen':amount}
    if decline:payload['reason']='synthetic refusal';action='customer_terminal_decline'
    else:payload.update(confirmed=True,statement='synthetic explicit consent');action='customer_terminal_consent'
    return current(r,m,case,op,action,payload,'customer')

def financial_snapshot(r,m,case):
    # Assert persistence is unchanged, not that the planned fee is actual travel.
    req=m.booking(case)
    return json.loads(r.sql(f"""SELECT jsonb_build_object(
      'booking',(SELECT to_jsonb(x) FROM public.requests x WHERE id='{req}'),
      'payments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.payment_sessions x WHERE request_id='{req}'),
      'acceptedRoutes',(SELECT jsonb_agg(to_jsonb(x)) FROM rd_private.accepted_routes x WHERE request_id='{req}'));"""))

def row(r,table,key,value):
    return json.loads(r.sql(f"SELECT to_jsonb(x) FROM rd_private.{table} x WHERE {key}={o.lit(value)};"))

def setup(r,m,case,status='driving'):
    assert status in ['accepted','driving']
    r.sql(f"INSERT INTO public.payment_sessions(id,status) VALUES ('{m.payment(case)}','pending');")
    r.sql(m.origin_sql(case))
    r.sql(f"""BEGIN;
      INSERT INTO public.requests(id,status,customer_token_hash,pickup_address,destination_address)
      VALUES ('{m.booking(case)}','{status}',repeat('a',64),'架空出発地','架空目的地');
      UPDATE public.payment_sessions SET status='paid',request_id='{m.booking(case)}' WHERE id='{m.payment(case)}';
      COMMIT;""")
    r.scalar(f"SELECT revision FROM rd_private.case_head WHERE request_id='{m.booking(case)}';",0)

def route_proposal(r,m,case,op,label):
    payload=next(p for a,p,_ in o.writer_payloads(m,case) if a=='route_propose')
    payload['points'][-1]['address']=label
    return current(r,m,case,op,'route_propose',payload)

def route_present(r,m,case,op,proposal_op):
    return current(r,m,case,op,'route_present',{'proposalId':m.operation(proposal_op)})

def route_consent(r,m,case,op,proposal_op):
    p=row(r,'route_proposals','proposal_id',m.operation(proposal_op))
    return current(r,m,case,op,'customer_consent',{'proposalId':p['proposal_id'],
      'presentationId':p['presentation_id'],'quotedTotalYen':p['quote']['serverQuote']['total_fee'],'consent':True},'customer')

def make_terms(r,m,case,base_op):
    save(r,request(r,m,case,base_op))
    save(r,link(r,m,case,base_op+1,base_op))
    save(r,quote(r,m,case,base_op+2,base_op+1))
    return base_op+1,base_op+2

def run(r,coverage,m):
    # Outbox base scenarios already restored the fixture owner into SESSION2.
    for case in range(301,311):setup(r,m,case,'accepted' if case==310 else 'driving')
    # A valid but unrelated confirmed customer/session distinguishes original
    # checkout binding failure from an absent/invalid identity.
    r.sql(f"INSERT INTO auth.users(id,email_confirmed_at) VALUES ('{OTHER_CUSTOMER}',clock_timestamp());")
    r.sql(f"INSERT INTO auth.sessions VALUES ('{OTHER_SESSION}','{OTHER_CUSTOMER}',NULL,'aal1',clock_timestamp(),clock_timestamp()+interval '1 hour');")

    # Accepted route remains active. A second, unaccepted presentation becomes
    # immutable superseded history, without changing its quote/presentation.
    case=301
    save(r,route_proposal(r,m,case,1000,'承諾済み架空目的地'))
    proposed=row(r,'route_proposals','proposal_id',m.operation(1000))
    presentation=route_present(r,m,case,1001,1000);save(r,presentation)
    presented=row(r,'route_proposals','proposal_id',m.operation(1000))
    assert presented['status']=='presented' and presented['presented_at'] is not None
    assert presented['presented_revision']==presentation['expectedRevision']+1
    r.scalar(f"SELECT expires_at=presented_at+interval '30 minutes' FROM rd_private.route_proposals WHERE proposal_id='{m.operation(1000)}';",'t')
    for field in proposed:
        if field not in ['status','presented_at','presented_revision','expires_at']:
            assert proposed[field]==presented[field],field
    # A first presentation may refresh its existing 30-minute consent window.
    # It cannot rewrite the quoted economics or become a new proposal, and an
    # exact response-loss retry cannot extend that window a second time.
    r.sql(o.writer(presentation))
    assert row(r,'route_proposals','proposal_id',m.operation(1000))==presented
    for assignment in [
      "expires_at=expires_at+interval '1 minute'",
      "status='proposed',presented_at=NULL,presented_revision=NULL",
      "price_comparison=jsonb_set(price_comparison,'{after,amountYen}','1'::jsonb)",
    ]:
        r.sql(f"UPDATE rd_private.route_proposals SET {assignment} WHERE proposal_id='{m.operation(1000)}';",expect_error='RD_ROUTE_PRICE_HISTORY_IMMUTABLE')
        assert row(r,'route_proposals','proposal_id',m.operation(1000))==presented
        assert revision(r,m,case)==presentation['expectedRevision']+1
    r.scalar(f"SELECT count(*) FROM rd_private.operation_receipts WHERE operation_id='{presentation['operationId']}';",1)
    r.scalar('SELECT count(*) FROM rd_private.operation_audit_context;',0)
    save(r,route_consent(r,m,case,1002,1000))
    save(r,route_proposal(r,m,case,1003,'未承諾の架空目的地'))
    save(r,route_present(r,m,case,1004,1003))
    old=row(r,'route_proposals','proposal_id',m.operation(1003));money=financial_snapshot(r,m,case)
    e=request(r,m,case,1005);save(r,e);after=row(r,'route_proposals','proposal_id',m.operation(1003))
    assert after['status']=='superseded' and after['superseded_by_request_id']==e['operationId'] and after['superseded_at']
    for field in old:
        if field not in ['status','superseded_by_request_id','superseded_at']:assert old[field]==after[field],field
    assert financial_snapshot(r,m,case)==money
    r.sql(o.writer(route_consent(r,m,case,1006,1003)),expect_error='RD_CUSTOMER_TERMINATION_OPEN')
    r.sql(f"UPDATE rd_private.route_proposals SET reason='rewrite' WHERE proposal_id='{m.operation(1003)}';",expect_error='RD_SUPERSEDED_ROUTE_IMMUTABLE')
    r.sql(f"DELETE FROM rd_private.route_proposals WHERE proposal_id='{m.operation(1003)}';",expect_error='RD_SUPERSEDED_ROUTE_IMMUTABLE')
    r.sql(f"UPDATE rd_private.route_proposals SET status='superseded',superseded_by_request_id='{m.operation(1005)}',superseded_at={o.lit(after['superseded_at'])} WHERE proposal_id='{m.operation(1000)}';",expect_error='RD_SUPERSEDED_ROUTE_EVIDENCE_INVALID')
    r.sql(o.writer(request(r,m,case,1007)),expect_error='RD_CUSTOMER_TERMINATION_ALREADY_OPEN')
    r.sql(f"UPDATE rd_private.customer_termination_requests SET reason='rewrite' WHERE customer_request_id='{m.operation(1005)}';",expect_error='RD_CUSTOMER_TERMINATION_HISTORY_IMMUTABLE')
    r.sql(f"DELETE FROM rd_private.customer_termination_requests WHERE customer_request_id='{m.operation(1005)}';",expect_error='RD_CUSTOMER_TERMINATION_HISTORY_IMMUTABLE')
    r.sql(o.writer(e));assert revision(r,m,case)==e['expectedRevision']+1
    assert financial_snapshot(r,m,case)==money
    coverage.mark('E-PG-26','First route presentation refreshes its bounded consent window; replay/extension/reversal/economic rewrite cannot change it; customer request supersedes only pending route while accepted route, quote/points/history and finances remain preserved')

    # Running wait remains stoppable/confirmable; unrelated writes cannot
    # proceed while customer intent is open. Linking requires wait resolution.
    case=302
    started=current(r,m,case,1100,'wait_start',{'kind':'stop','notified':True});save(r,started)
    save(r,request(r,m,case,1101))
    for i,(action,payload,actor) in enumerate(o.writer_payloads(m,case),1110):
        if action in ['wait_stop_claim','wait_confirm','customer_termination_request','termination_plan_from_customer']:continue
        e=current(r,m,case,i,action,payload,actor)
        r.sql(o.writer(e),expect_error='RD_CUSTOMER_TERMINATION_OPEN');o.counts(r,e,0,0)
    r.sql(o.writer(link(r,m,case,1140,1101)),expect_error='RD_TERMINATION_NOT_READY')
    stop=current(r,m,case,1141,'wait_stop_claim',{'intervalId':m.operation(1100)});save(r,stop)
    confirm=current(r,m,case,1142,'wait_confirm',{'intervalId':m.operation(1100),'mode':'waive','reason':'synthetic wait resolved'});save(r,confirm)
    save(r,link(r,m,case,1143,1101))
    r.scalar(f"SELECT phase FROM rd_private.wait_interval WHERE interval_id='{m.operation(1100)}';",'waived')
    r.scalar(f"SELECT source_customer_request_id FROM rd_private.termination_plans WHERE plan_id='{m.operation(1143)}';",m.operation(1101))
    coverage.mark('E-PG-27','Open customer intent blocks unrelated writers; active wait can stop/confirm; owner link blocked until resolved and uses a separate operation ID')

    # Owner link issued while request transaction is uncommitted must wait for
    # the same booking, then link exactly that committed request and revision.
    case=303;customer=request(r,m,case,1200)
    owner=o.envelope(m,case,1201,1,'termination_plan_from_customer',{'customerRequestId':customer['operationId'],'reason':'synthetic concurrent link'})
    lock=r.locker(o.writer(customer));pending=r.spawn(o.writer(owner),'customer-request-before-link')
    r.await_blocked('customer-request-before-link');r.release(lock);o.finish_process(r,pending,'customer-request-before-link')
    o.terminal_result(r,customer,'committed');o.terminal_result(r,owner,'committed')
    cr=row(r,'customer_termination_requests','customer_request_id',customer['operationId'])
    assert cr['state']=='linked' and cr['linked_plan_id']==owner['operationId'] and owner['operationId']!=customer['operationId']
    plan=row(r,'termination_plans','plan_id',owner['operationId'])
    assert cr['customer_id']==m.CUSTOMER and cr['auth_session_id']==m.CUSTOMER_SESSION
    assert plan['owner_id']==m.OWNER and plan['source_customer_request_id']==customer['operationId']
    for e in [customer,owner]:
        receipt=row(r,'operation_receipts','operation_id',e['operationId'])
        assert receipt['actor_id']==e['actorId'] and receipt['action']==e['action'] and receipt['body']==e['payload']
    # Discarded submission response is recovered independently; exact retry
    # cannot create another customer request, plan, receipt or revision.
    before=o.state(r,owner);recovered=o.terminal_result(r,owner,'committed')
    r.sql(o.writer(owner));assert o.terminal_result(r,owner,'committed')==recovered
    assert o.state(r,owner)==before
    case=304;save(r,request(r,m,case,1210))
    a=link(r,m,case,1211,1210);b=link(r,m,case,1212,1210)
    before=o.state(r,a);r.sql('BEGIN;\n'+o.writer(a)+'\nROLLBACK;')
    assert o.state(r,a)==before;o.counts(r,a,0,0)
    lock=r.locker(o.writer(a));pending=r.spawn(o.writer(b),'competing-customer-plan-links')
    r.await_blocked('competing-customer-plan-links');r.release(lock)
    o.finish_process(r,pending,'competing-customer-plan-links','RD_TERMINATION_REVISION_STALE')
    o.terminal_result(r,a,'committed');o.counts(r,b,0,0)
    r.scalar(f"SELECT count(*) FROM rd_private.termination_plans WHERE source_customer_request_id='{m.operation(1210)}';",1)
    coverage.mark('E-PG-28','Request-before-link actual lock wait and two competing owner links yield one source-linked plan, distinct IDs, no duplicate receipt')

    # Both deterministic decision orders; old receipt can be replayed, whereas
    # the opposite decision is rejected even with the refreshed case revision.
    for case,base,decline_first in [(305,1300,True),(306,1320,False)]:
        plan_id,quote_id=make_terms(r,m,case,base)
        before=financial_snapshot(r,m,case)
        if decline_first:
            # A valid original customer cannot decide different terms, and a
            # different valid customer/session cannot borrow original binding.
            unchanged=o.state(r,current(r,m,case,1700,'customer_terminal_decline',{},'customer'))
            for i,decline in enumerate([False,True]):
                good=decision(r,m,case,1700+i*4,plan_id,quote_id,decline)
                failures=[
                  ({**good,'payload':{**good['payload'],'finalChargeYen':4501}},'RD_TERMINAL_QUOTE_STALE'),
                  ({**good,'operationId':m.operation(1701+i*4),'payload':{**good['payload'],'quoteId':m.operation(1999)}},'RD_TERMINAL_QUOTE_STALE'),
                  ({**good,'operationId':m.operation(1702+i*4),'actorId':OTHER_CUSTOMER,'sessionId':OTHER_SESSION},'RD_TERMINAL_CUSTOMER_DENIED'),
                  ({**good,'operationId':m.operation(1703+i*4),'sessionId':OTHER_SESSION},'RD_TERMINAL_CUSTOMER_DENIED'),
                ]
                for bad,error in failures:r.sql(o.writer(bad),expect_error=error);o.counts(r,bad,0,0)
            assert o.state(r,good)==unchanged and financial_snapshot(r,m,case)==before
        winner=decision(r,m,case,base+3,plan_id,quote_id,decline_first)
        loser=decision(r,m,case,base+4,plan_id,quote_id,not decline_first)
        undecided=o.state(r,winner);r.sql('BEGIN;\n'+o.writer(winner)+'\nROLLBACK;')
        assert o.state(r,winner)==undecided;o.counts(r,winner,0,0)
        lock=r.locker(o.writer(winner));label='decline-before-consent' if decline_first else 'consent-before-decline'
        pending=r.spawn(o.writer(loser),label);r.await_blocked(label);r.release(lock)
        o.finish_process(r,pending,label,'RD_TERMINAL_CONSENT_REVISION_STALE')
        o.terminal_result(r,winner,'committed');o.counts(r,loser,0,0)
        committed_state=o.state(r,winner)
        r.sql(o.writer(winner));o.terminal_result(r,winner,'committed')
        assert o.state(r,winner)==committed_state
        refreshed={**loser,'expectedRevision':revision(r,m,case)}
        r.sql(o.writer(refreshed),expect_error='RD_TERMINAL_QUOTE_STALE');o.counts(r,refreshed,0,0)
        q=row(r,'terminal_terms','quote_id',m.operation(quote_id))
        assert (q['decline_operation_id'] is not None)==decline_first
        assert (q['consent_operation_id'] is not None)!=decline_first
        assert financial_snapshot(r,m,case)==before
        if decline_first:
            # Even a fresh revision and syntactically valid invented consent
            # cannot pass provider preflight or create finalization evidence.
            final=current(r,m,case,1710,'terminal_finalize',{'planId':m.operation(plan_id),
              'quoteId':m.operation(quote_id),'consentId':m.operation(1998),'additionalPaymentId':None})
            for variant in ['terminal_target',None]:
                r.sql(o.writer(final,variant),expect_error='RD_TERMINAL_CONSENT_MISSING');o.counts(r,final,0,0)
            assert o.state(r,final)==committed_state and financial_snapshot(r,m,case)==before
    coverage.mark('E-PG-29','Exact amount/quote and original customer/session required; decline/consent races serialize both orders, replay stable; declined quote cannot preflight/finalize or change evidence/status/finances')

    # Declined quote remains immutable history; withdraw and a fresh customer
    # request produce new plan+quote IDs and require a new explicit decision.
    case=305;old_quote=row(r,'terminal_terms','quote_id',m.operation(1302));old_request=row(r,'customer_termination_requests','customer_request_id',m.operation(1300))
    save(r,withdraw(r,m,case,1400,1301));save(r,request(r,m,case,1401))
    save(r,link(r,m,case,1402,1401));save(r,quote(r,m,case,1403,1402,4300))
    new_quote=row(r,'terminal_terms','quote_id',m.operation(1403))
    assert new_quote['consent_operation_id'] is None and new_quote['decline_operation_id'] is None
    assert row(r,'terminal_terms','quote_id',m.operation(1302))==old_quote
    assert row(r,'customer_termination_requests','customer_request_id',m.operation(1300))==old_request
    r.sql(o.writer(decision(r,m,case,1404,1301,1302,False)),expect_error='RD_TERMINAL_PLAN_STALE')
    # Replacing the plan/revision cannot make old declined terms valid.
    r.sql(o.writer(decision(r,m,case,1406,1402,1302,False)),expect_error='RD_TERMINAL_QUOTE_STALE')
    save(r,decision(r,m,case,1405,1402,1403,False,4300))
    # Previously superseded route cannot revive after the linked plan withdraws.
    case=301;save(r,link(r,m,case,1410,1005));save(r,withdraw(r,m,case,1411,1410))
    assert row(r,'route_proposals','proposal_id',m.operation(1003))==after
    assert financial_snapshot(r,m,case)==money
    r.sql(o.writer(route_consent(r,m,case,1412,1003)),expect_error='RD_QUOTE_EXPIRED_OR_NOT_PRESENTED')
    save(r,request(r,m,case,1413))
    coverage.mark('E-PG-30','Withdraw/new request/new plan/new quote preserves old declined terms and source history; prior superseded route never revives; new quote requires new consent')

    # Explicit transaction rollback must restore request, route, revision and
    # receipt together; expiry while blocked must leave no intent behind.
    case=307;save(r,route_proposal(r,m,case,1500,'rollback対象の架空目的地'))
    e=request(r,m,case,1501);before=o.state(r,e);r.sql('BEGIN;\n'+o.writer(e)+'\nROLLBACK;')
    assert o.state(r,e)==before;o.counts(r,e,0,0)
    case=308;e=request(r,m,case,1510);e['exp']=int(time.time())+2;before=o.state(r,e)
    lock=r.locker(f"DO $$ BEGIN PERFORM 1 FROM public.requests WHERE id='{m.booking(case)}' FOR UPDATE; END $$;")
    pending=r.spawn(o.writer(e),'customer-request-expiry-after-lock');r.await_blocked('customer-request-expiry-after-lock')
    while time.time()<=e['exp']+0.1:time.sleep(0.1)
    r.release(lock);o.finish_process(r,pending,'customer-request-expiry-after-lock','RD_CUSTOMER_TERMINATION_AUTH_DENIED')
    assert o.state(r,e)==before;o.counts(r,e,0,0)
    e=request(r,m,case,1511)
    lock=r.locker(f"UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='{m.CUSTOMER_SESSION}';")
    pending=r.spawn(o.writer(e),'customer-session-expiry-after-lock');r.await_blocked('customer-session-expiry-after-lock')
    r.release(lock);o.finish_process(r,pending,'customer-session-expiry-after-lock','RD_CUSTOMER_TERMINATION_AUTH_DENIED')
    assert o.state(r,e)==before;o.counts(r,e,0,0)
    r.sql(f"UPDATE auth.sessions SET not_after=clock_timestamp()+interval '1 hour' WHERE id='{m.CUSTOMER_SESSION}';")
    # A cancelled-before-driving request records intent without changing status.
    case=310;before=financial_snapshot(r,m,case);save(r,request(r,m,case,1520,'cancel'))
    assert financial_snapshot(r,m,case)==before
    coverage.mark('E-PG-31','Customer intent+superseded history+receipt rollback together; lock-wait JWT and synthetic session expiry leave no intent; pre-driving cancel remains intent without status/financial changes')

    # New actions use the same recovery contract even when business switches
    # are OFF. Closure is independently looked up, not treated as a submit.
    case=309;envelopes=[]
    for i,(action,payload,actor) in enumerate(o.writer_payloads(m,case),1600):
        if action in ['customer_termination_request','termination_plan_from_customer','customer_terminal_decline']:
            e=current(r,m,case,i,action,payload,actor);r.sql(o.close(e));envelopes.append(e)
    assert len(envelopes)==3
    r.sql('UPDATE rd_private.ops_settings SET enabled=false,terminal_terms_enabled=false WHERE id=1;')
    for e in envelopes:
        first=o.terminal_result(r,e);r.sql(o.close(e));assert o.terminal_result(r,e)==first;o.counts(r,e,0,1)
    r.sql('UPDATE rd_private.ops_settings SET enabled=true,terminal_terms_enabled=true WHERE id=1;')
    for e in envelopes:r.sql(o.writer(e),expect_error=o.CLOSED)
    r.scalar('SELECT count(*) FROM rd_private.operation_receipts r JOIN rd_private.operation_terminal_results t USING(operation_id);',0)
    coverage.mark('E-PG-32','All three new action closures remain exactly recoverable with business switches OFF; independent lookup stable, late writers fenced, no double evidence')
