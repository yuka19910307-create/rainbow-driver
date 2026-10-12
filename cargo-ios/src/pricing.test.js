'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {calculate} = require('./pricing.js');

function baseline(changes={}) {
  return {
    toPickup:{km:100,minutes:150},delivery:{km:40,minutes:65},
    afterDelivery:{km:140,minutes:190},returnPlan:'route',
    driverStatus:'accepting',locationFresh:true,sameDayPickup:true,
    needsPreviousDayDeparture:false,routeVerified:true,
    cargoConfirmed:true,tollConfirmed:true,
    parameters:{hourlyTargetYen:4000,vehicleYenPerKm:45,
      dispatchCostYen:2000,handlingBufferMinutes:30,
      riskReservePct:15,roundUpYen:500,expectedTollParkingYen:1500},
    ...changes
  };
}
test('3 legs, traffic-aware minutes, round-up and separate expenses',()=>{
  const v=calculate(baseline());
  assert.equal(v.sumKm,280);
  assert.equal(v.sumMinutes,435);
  assert.equal(v.internalFloorYen,50500);
  assert.equal(v.provisionalCostWithExpensesYen,52000);
  assert.equal(v.reviewState,'manual_review');
  assert.deepEqual(v.warnings,[]);
  assert.equal('customerPriceYen' in v,false);
});
test('traffic delay alone raises internal minimum',()=>{
  const old=calculate(baseline());
  const delayed=calculate(baseline({toPickup:{km:100,minutes:250}}));
  assert.ok(delayed.internalFloorYen>old.internalFloorYen);
});
test('never silently assume the driver return leg costs zero',()=>{
  assert.throws(()=>calculate(baseline({returnPlan:'unknown'})),/配送後の移動予定/);
  assert.throws(()=>calculate(baseline({afterDelivery:null})),/配送後の移動/);
  const result=calculate(baseline({returnPlan:'not_required',afterDelivery:null}));
  assert.equal(result.reviewState,'consultation_only');
  assert.ok(result.warnings.some(x=>x.includes('移動費不要')));
});
test('offline, stale GPS or unverified route forbid unreviewed booking',()=>{
  const r=calculate(baseline({driverStatus:'break',locationFresh:false,routeVerified:false}));
  assert.equal(r.reviewState,'consultation_only');
  assert.equal(r.warnings.length,3);
});
test('reservations and previous-day departure rejected from app',()=>{
  const a=calculate(baseline({sameDayPickup:false}));
  const b=calculate(baseline({needsPreviousDayDeparture:true}));
  assert.equal(a.reviewState,'consultation_only');
  assert.equal(b.reviewState,'consultation_only');
});
test('reject missing, invalid and negative costs',()=>{
  const p=baseline().parameters;
  assert.throws(()=>calculate(baseline({toPickup:{km:'',minutes:15}})),/回送距離/);
  assert.throws(()=>calculate(baseline({delivery:{km:-4,minutes:10}})),/配送距離/);
  assert.throws(()=>calculate(baseline({delivery:{km:Infinity,minutes:10}})),/配送距離/);
  assert.throws(()=>calculate(baseline({parameters:{...p,riskReservePct:101}})),/リスク/);
  assert.throws(()=>calculate(baseline({parameters:{...p,hourlyTargetYen:''}})),/時間単価/);
});

test('waiting and additional handling use independent buckets',()=>{
  const {extraTimeFee,supplementaryFees}=require('./pricing.js');
  assert.equal(extraTimeFee(5),0);
  assert.equal(extraTimeFee(6),500);
  assert.equal(extraTimeFee(15),500);
  assert.equal(extraTimeFee(16),1000);
  assert.equal(extraTimeFee(30),1000);
  assert.equal(extraTimeFee(31),1500);
  assert.equal(extraTimeFee(46),2000);
  assert.equal(supplementaryFees(6,10).subtotalYen,1000);
  assert.equal(supplementaryFees(6,6).waitingYen,500);
  assert.throws(()=>extraTimeFee(-1),/範囲外/);
});
