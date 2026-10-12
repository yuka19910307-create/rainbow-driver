import React, {useState} from 'react';
import {StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import {calculate, supplementaryFees} from './pricing';

const BLUE='#192f4c', MUTED='#65758a', BG='#f2f6fa', BORDER='#dce5ee';
const initial={
  deadheadKm:'',deadheadMinutes:'',deliveryKm:'',deliveryMinutes:'',
  afterKm:'',afterMinutes:'',hourly:'',perKm:'',dispatch:'',
  bufferMinutes:'',riskPercent:'',roundYen:'500',tollYen:'0',
  waitMinutes:'0',handlingMinutes:'0'
};
function NumericField({label,value,onChange,placeholder}) {
  return <View style={sty.field}>
    <Text style={sty.label}>{label}</Text>
    <TextInput
      style={sty.input} keyboardType="decimal-pad" value={value}
      onChangeText={onChange} placeholder={placeholder || '数値を入力'}
      placeholderTextColor="#8c9bab" selectTextOnFocus
    />
  </View>;
}
function Choice({label,selected,onPress}) {
  return <TouchableOpacity accessibilityRole="button" onPress={onPress}
    style={[sty.choice,selected&&sty.choiceSelected]}>
    <Text style={[sty.choiceText,selected&&sty.choiceTextSelected]}>{selected?'✓ ':''}{label}</Text>
  </TouchableOpacity>;
}
function Money({label,value,primary}) {
  return <View style={sty.money}>
    <Text style={sty.moneyLabel}>{label}</Text>
    <Text style={primary?sty.strong:sty.moneyValue}>{Math.ceil(value).toLocaleString('ja-JP')}円</Text>
  </View>;
}

export default function PricingPanel({driverStatus,locationFresh}) {
  const [data,setData]=useState(initial);
  const [returnPlan,setReturnPlan]=useState('route');
  const [routeVerified,setRouteVerified]=useState(false);
  const [sameDayPickup,setSameDayPickup]=useState(false);
  const [cargoConfirmed,setCargoConfirmed]=useState(false);
  const [tollConfirmed,setTollConfirmed]=useState(false);
  const [noReturnReasonConfirmed,setNoReturnReasonConfirmed]=useState(false);
  const [requiresPreviousDay,setRequiresPreviousDay]=useState(false);
  const [result,setResult]=useState(null);
  const [extras,setExtras]=useState(null);
  const [error,setError]=useState('');
  function update(key,value) {
    setData(prev=>({...prev,[key]:value}));
    setResult(null);setExtras(null);setError('');
  }
  const field=(key,label,placeholder)=> <NumericField
    label={label} value={data[key]} placeholder={placeholder}
    onChange={v=>update(key,v)} />;
  function compute() {
    setResult(null);setError('');
    try {
      const estimate=calculate({
        toPickup:{km:data.deadheadKm,minutes:data.deadheadMinutes},
        delivery:{km:data.deliveryKm,minutes:data.deliveryMinutes},
        returnPlan,
        afterDelivery:returnPlan==='route'?{km:data.afterKm,minutes:data.afterMinutes}:null,
        driverStatus,locationFresh,sameDayPickup,
        needsPreviousDayDeparture:requiresPreviousDay,
        routeVerified,cargoConfirmed,tollConfirmed,noReturnReasonConfirmed,
        parameters:{
          hourlyTargetYen:data.hourly,
          vehicleYenPerKm:data.perKm,
          dispatchCostYen:data.dispatch,
          handlingBufferMinutes:data.bufferMinutes,
          riskReservePct:data.riskPercent,
          roundUpYen:data.roundYen,
          expectedTollParkingYen:data.tollYen
        }
      });
      const fees=supplementaryFees(data.waitMinutes,data.handlingMinutes);
      setResult(estimate);setExtras(fees);
    } catch(e) {setError(String(e.message||e));}
  }
  return <View style={sty.card}>
    <Text style={sty.title}>4. 最低受注額の仮計算</Text>
    <Text style={sty.warning}>ドライバー社内検討用です。入力値・結果はサーバーに保存せず、顧客へ公開しません。金額は正式な運賃・税込見積ではありません。</Text>
    <Text style={sty.section}>① 回送：現在地 → 集荷先</Text>
    <View style={sty.two}>{field('deadheadKm','距離 (km)','例：80')}{field('deadheadMinutes','時間 (分)','例：120')}</View>
    <Text style={sty.section}>② 配送：集荷先 → 納品先</Text>
    <View style={sty.two}>{field('deliveryKm','距離 (km)','例：40')}{field('deliveryMinutes','時間 (分)','例：60')}</View>
    <Text style={sty.section}>③ 配送後の移動</Text>
    <View style={sty.two}>
      <Choice label="移動あり" selected={returnPlan==='route'} onPress={()=>{setReturnPlan('route');setResult(null)}}/>
      <Choice label="移動不要（要確認）" selected={returnPlan==='not_required'} onPress={()=>{setReturnPlan('not_required');setResult(null)}}/>
    </View>
    {returnPlan==='route'?
      <View style={sty.two}>{field('afterKm','距離 (km)','例：90')}{field('afterMinutes','時間 (分)','例：130')}</View>:
      <Choice label="配送後の移動費が不要な理由を確認済み" selected={noReturnReasonConfirmed}
        onPress={()=>{setNoReturnReasonConfirmed(!noReturnReasonConfirmed);setResult(null)}}/>}
    <Text style={sty.section}>④ 社内原価の仮定（後で変更可能）</Text>
    <Text style={sty.hint}>下記は固定料金ではありません。自身の採算条件を入力してください。</Text>
    <View style={sty.two}>{field('hourly','目標時間単価 (円/時)','例：4000')}{field('perKm','車両コスト (円/km)','例：45')}</View>
    <View style={sty.two}>{field('dispatch','出動固定コスト (円)','例：2000')}{field('bufferMinutes','作業予備時間 (分)','例：30')}</View>
    <View style={sty.two}>{field('riskPercent','リスク余裕率 (%)','例：15')}{field('roundYen','切上げ単位 (円)','500')}</View>
    {field('tollYen','高速・駐車費の概算 (円)','0')}
    <Text style={sty.section}>⑤ 別途の待機・追加荷役（実測する場合）</Text>
    <View style={sty.two}>{field('waitMinutes','待機時間 (分)','0')}{field('handlingMinutes','追加荷役 (分)','0')}</View>
    <Text style={sty.hint}>待機と追加荷役は同じ時間を二重に計上しません。0～5分無料、6～15分500円、16～30分1,000円、以後15分ごと500円加算の仮ルールです。</Text>
    <Text style={sty.section}>⑥ 確認項目</Text>
    <Choice label="即時・当日の集荷案件" selected={sameDayPickup}
      onPress={()=>{setSameDayPickup(!sameDayPickup);setResult(null)}}/>
    <Choice label="Google Maps等で交通状況込みの経路を確認済み" selected={routeVerified}
      onPress={()=>{setRouteVerified(!routeVerified);setResult(null)}}/>
    <Choice label="重量・荷姿・サイズ・個数を確認済み" selected={cargoConfirmed}
      onPress={()=>{setCargoConfirmed(!cargoConfirmed);setResult(null)}}/>
    <Choice label="高速・駐車費の扱いを確認済み" selected={tollConfirmed}
      onPress={()=>{setTollConfirmed(!tollConfirmed);setResult(null)}}/>
    <Choice label="集荷のために前日出発が必要" selected={requiresPreviousDay}
      onPress={()=>{setRequiresPreviousDay(!requiresPreviousDay);setResult(null)}}/>
    <TouchableOpacity style={sty.go} onPress={compute}>
      <Text style={sty.goText}>社内最低受注額を仮計算</Text>
    </TouchableOpacity>
    {error?<Text style={sty.error}>入力確認：{error}</Text>:null}
    {result?<View style={sty.result}>
      <Text style={sty.resultTitle}>社内最低受注額の試算</Text>
      <Money label="最低受注額（高速・駐車費を除く）" value={result.internalFloorYen} primary/>
      <Money label="高速・駐車費（概算）" value={result.tollParkingEstimatedYen}/>
      <Money label="費用込みの検討金額" value={result.provisionalCostWithExpensesYen}/>
      <Money label="待機・追加荷役（別途）" value={extras.subtotalYen}/>
      <Text style={sty.hint}>全行程：{result.sumKm} km ／ {Math.ceil(result.sumMinutes)} 分（作業予備時間含む）</Text>
      <Text style={sty.hint}>判定：{result.reviewState==='manual_review'?'ドライバーによる最終確認が必要':'個別相談・条件未確認'}</Text>
      {result.warnings.map((s,i)=><Text key={i} style={sty.warning}>・{s}</Text>)}
      <Text style={sty.hint}>{result.disclaimer}</Text>
    </View>:null}
  </View>;
}
const sty=StyleSheet.create({
 card:{marginHorizontal:14,marginTop:14,padding:18,backgroundColor:'white',borderColor:BORDER,borderWidth:1,borderRadius:16},
 title:{fontSize:18,fontWeight:'700',color:BLUE,marginBottom:12},
 section:{fontSize:14,fontWeight:'700',color:BLUE,marginTop:19,marginBottom:8},
 two:{flexDirection:'row',gap:8},field:{flex:1,marginVertical:6,minWidth:0},
 label:{fontSize:12,fontWeight:'700',color:BLUE,marginBottom:5},
 input:{borderWidth:1,borderColor:'#bdcbd9',borderRadius:9,padding:12,fontSize:16,color:BLUE},
 choice:{borderRadius:9,backgroundColor:'#edf2f7',padding:13,marginTop:7,justifyContent:'center',flex:1},
 choiceSelected:{backgroundColor:BLUE},choiceText:{color:BLUE,fontSize:13,fontWeight:'600'},choiceTextSelected:{color:'#fff'},
 warning:{backgroundColor:'#fff7e7',padding:10,color:'#865610',fontSize:12,lineHeight:19,borderRadius:8,marginTop:6},
 hint:{fontSize:12,color:MUTED,marginTop:8,lineHeight:19},
 go:{backgroundColor:BLUE,alignItems:'center',borderRadius:10,padding:15,marginTop:20},
 goText:{color:'#fff',fontWeight:'700'},
 error:{backgroundColor:'#ffefef',padding:10,color:'#a42632',fontSize:13,marginTop:10},
 result:{backgroundColor:BG,padding:14,marginTop:16,borderRadius:12},
 resultTitle:{fontSize:16,fontWeight:'700',color:BLUE,marginBottom:9},
 money:{flexDirection:'row',justifyContent:'space-between',gap:8,paddingVertical:7,borderBottomWidth:1,borderColor:BORDER},
 moneyLabel:{fontSize:12,color:MUTED,flex:1},moneyValue:{fontSize:15,fontWeight:'700',color:BLUE},
 strong:{fontSize:20,fontWeight:'800',color:BLUE}
});
