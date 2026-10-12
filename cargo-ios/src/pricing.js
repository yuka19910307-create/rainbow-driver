/* Rainbow Driver Cargo: INTERNAL preliminary acceptance floor only.
 * Never use this output to auto-accept an order, charge a customer, or issue a quote.
 * No fixed public rates are embedded. Operator must enter cost assumptions.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CargoPricing = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function number(value, label, min, max) {
    if (value === null || value === undefined || value === '' ||
        (typeof value === 'string' && !value.trim())) {
      throw new Error(label + 'が未入力です');
    }
    var n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(label + 'の数値が範囲外です');
    }
    return n;
  }

  function route(value, label) {
    if (!value) throw new Error(label + 'の距離・時間が未入力です');
    return {
      km: number(value.km, label + '距離(km)', 0, 5000),
      minutes: number(value.minutes, label + '所要時間(分)', 0, 14400)
    };
  }

  function calculate(input) {
    if (!input || typeof input !== 'object') throw new Error('計算条件が未入力です');
    var empty = route(input.toPickup, '回送');
    var loaded = route(input.delivery, '配送');
    if (input.returnPlan !== 'route' && input.returnPlan !== 'not_required') {
      throw new Error('配送後の移動予定を選択してください');
    }
    var back = input.returnPlan === 'route'
      ? route(input.afterDelivery, '配送後の移動') : {km: 0, minutes: 0};

    var p = input.parameters || {};
    var hourly = number(p.hourlyTargetYen, '目標時間単価', 0, 100000);
    var yenPerKm = number(p.vehicleYenPerKm, '車両変動コスト', 0, 2000);
    var fixed = number(p.dispatchCostYen, '出動固定コスト', 0, 1000000);
    var bufferMin = number(p.handlingBufferMinutes, '準備・荷扱い予備時間', 0, 1440);
    var riskPercent = number(p.riskReservePct, 'リスク留保率', 0, 100);
    var roundYen = number(p.roundUpYen, '切り上げ単位', 1, 100000);
    var toll = number(p.expectedTollParkingYen, '高速・駐車費概算', 0, 1000000);
    if (!Number.isInteger(roundYen)) throw new Error('切り上げ単位は整数にしてください');

    var totalKm = empty.km + loaded.km + back.km;
    var totalMinutes = empty.minutes + loaded.minutes + back.minutes + bufferMin;
    var timeCost = hourly * totalMinutes / 60;
    var vehicleCost = yenPerKm * totalKm;
    var operatingCost = timeCost + vehicleCost + fixed;
    var floor = Math.ceil(operatingCost * (1 + riskPercent / 100) / roundYen) * roundYen;

    var warnings = [];
    if (input.driverStatus !== 'accepting') warnings.push('現在の稼働状態は受付可能ではありません');
    if (input.locationFresh !== true) warnings.push('GPS位置情報の更新確認が必要です');
    if (input.sameDayPickup !== true) warnings.push('即時・当日集荷以外はアプリで受付しません');
    if (input.needsPreviousDayDeparture === true) warnings.push('前日出発が必要な案件は原則受けません');
    if (input.routeVerified !== true) warnings.push('道路経路・渋滞時間の実確認が必要です');
    if (input.cargoConfirmed !== true) warnings.push('荷姿・重量・積載可否の確認が必要です');
    if (input.tollConfirmed !== true) warnings.push('高速・駐車費の扱いが未確定です');
    if (input.returnPlan === 'not_required' && input.noReturnReasonConfirmed !== true) {
      warnings.push('配送後の移動費不要の根拠を確認してください');
    }

    return {
      internalFloorYen: floor,
      tollParkingEstimatedYen: toll,
      provisionalCostWithExpensesYen: floor + toll,
      sumKm: Math.round(totalKm * 100) / 100,
      sumMinutes: Math.round(totalMinutes * 100) / 100,
      breakdown: {
        toPickup: empty,
        delivery: loaded,
        afterDelivery: back,
        bufferMinutes: bufferMin,
        timeCostYen: Math.ceil(timeCost),
        vehicleCostYen: Math.ceil(vehicleCost),
        dispatchCostYen: fixed,
        riskReservePct: riskPercent
      },
      reviewState: warnings.length ? 'consultation_only' : 'manual_review',
      warnings: warnings,
      disclaimer: '社内の採算判断用・仮計算です。顧客見積、確定運賃、課税区分、決済額、受注確定ではありません。'
    };
  }

  return {calculate:calculate};
});
