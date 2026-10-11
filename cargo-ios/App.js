import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { CARGO_TASK, CARGO_ACTIVE_KEY, CARGO_FIX_META_KEY } from './src/locationTask';

const C = {
  navy: '#192f4c',
  blue: '#215c94',
  pale: '#f3f6f9',
  line: '#dce5ec',
  muted: '#65758a',
  ok: '#167452',
  red: '#aa3941',
  warning: '#82520c',
  white: '#ffffff'
};
const OPTIONS = [
  { key: 'offline', label: 'オフライン' },
  { key: 'accepting', label: '受付可能' },
  { key: 'delivering', label: '配送中' },
  { key: 'break', label: '休憩中' }
];
const dateString = (v) => v ? new Date(v).toLocaleString('ja-JP') : '未取得';
const isActiveStatus = (s) => s === 'accepting' || s === 'delivering';

export default function App() {
  const [status, setStatus] = useState('offline');
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('稼働を開始すると位置情報の取得を試みます。');
  const [messageType, setMessageType] = useState('normal');
  const [lastForeground, setLastForeground] = useState(null);
  const [lastMeta, setLastMeta] = useState(null);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const foregroundSub = useRef(null);
  const doing = useRef(false);

  const flash = (s, type = 'normal') => {
    if (!mounted.current) return;
    setMessage(s);
    setMessageType(type);
  };

  const clearForeground = useCallback(() => {
    if (foregroundSub.current) {
      foregroundSub.current.remove();
      foregroundSub.current = null;
    }
  }, []);

  const readState = useCallback(async () => {
    try {
      const [activeValue, latest, registered] = await Promise.all([
        AsyncStorage.getItem(CARGO_ACTIVE_KEY),
        AsyncStorage.getItem(CARGO_FIX_META_KEY),
        Location.hasStartedLocationUpdatesAsync(CARGO_TASK)
      ]);
      if (!mounted.current) return;
      setTracking(registered && activeValue === 'true');
      if (latest) {
        try { setLastMeta(JSON.parse(latest)); } catch {}
      }
      if (registered && activeValue !== 'true') {
        // Reconcile a persisted native task with an explicit earlier stop.
        await Location.stopLocationUpdatesAsync(CARGO_TASK);
        setTracking(false);
      }
      if (registered && activeValue === 'true') {
        setStatus((v) => isActiveStatus(v) ? v : 'accepting');
      }
    } catch {
      flash('稼働状態を読み取れませんでした。', 'error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    readState();
    const tick = setInterval(() => { if (mounted.current) setNow(Date.now()); }, 15000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        readState();
      }
    });
    return () => {
      mounted.current = false;
      clearInterval(tick);
      listener.remove();
      clearForeground();
      // Intentionally do not stop background tracking on component unmount.
      // Only explicit stop, offline, and break stop the native task.
    };
  }, [clearForeground, readState]);

  const startForeground = useCallback(async () => {
    clearForeground();
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 30, timeInterval: 10000 },
      (loc) => {
        if (!mounted.current) return;
        // Do not save or send coordinates.
        setLastForeground({
          timestamp: loc.timestamp,
          accuracyMeters: typeof loc.coords?.accuracy === 'number' ? Math.round(loc.coords.accuracy) : null
        });
      }
    );
    if (mounted.current) foregroundSub.current = sub;
    else sub.remove();
  }, [clearForeground]);

  const stopTracking = useCallback(async () => {
    if (doing.current) return false;
    doing.current = true;
    setBusy(true);
    clearForeground();
    try {
      await AsyncStorage.setItem(CARGO_ACTIVE_KEY, 'false');
      const active = await Location.hasStartedLocationUpdatesAsync(CARGO_TASK);
      if (active) await Location.stopLocationUpdatesAsync(CARGO_TASK);
      if (mounted.current) {
        setTracking(false);
        flash('GPSを停止しました。バックグラウンドでの位置更新も解除しました。', 'ok');
      }
      return true;
    } catch {
      flash('停止に失敗しました。位置情報の設定を確認してください。', 'error');
      return false;
    } finally {
      doing.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [clearForeground]);

  const changeStatus = async (next) => {
    if (busy || doing.current) return;
    if (!isActiveStatus(next) && tracking) {
      const stopped = await stopTracking();
      if (!stopped) return;
    }
    setStatus(next);
    if (next === 'offline' || next === 'break') {
      flash('受付を停止しています。GPSの稼働はOFFです。');
    } else if (!tracking) {
      flash('状態を選びました。「稼働開始」でGPSをONにしてください。');
    }
  };

  const startTracking = async () => {
    if (doing.current || !isActiveStatus(status)) {
      flash('先に「受付可能」または「配送中」を選択してください。', 'error');
      return;
    }
    doing.current = true;
    setBusy(true);
    try {
      if (!(await TaskManager.isAvailableAsync())) {
        flash('このビルドではバックグラウンドGPSを使えません。iPhone用の専用ビルドが必要です。', 'error');
        return;
      }
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        flash('位置情報の「このAppの使用中」の許可が必要です。', 'error');
        return;
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (bg.status !== 'granted') {
        flash('「常に許可」が必要です。許可されない場合はiPhoneの設定から位置情報を変更してください。', 'error');
        return;
      }
      const existing = await Location.hasStartedLocationUpdatesAsync(CARGO_TASK);
      if (!existing) {
        await Location.startLocationUpdatesAsync(CARGO_TASK, {
          accuracy: Location.Accuracy.High,
          distanceInterval: 70,
          deferredUpdatesDistance: 100,
          deferredUpdatesInterval: 60000,
          showsBackgroundLocationIndicator: true,
          pausesUpdatesAutomatically: false,
          activityType: Location.ActivityType.AutomotiveNavigation
        });
      }
      // Mark active only after native registration succeeds.
      await AsyncStorage.setItem(CARGO_ACTIVE_KEY, 'true');
      if (mounted.current) {
        setTracking(true);
        flash('GPS稼働を開始しました。ほかのアプリを使用した後、ここに戻って最終更新時刻を確認してください。', 'ok');
      }
      await startForeground();
    } catch {
      flash('GPSを開始できませんでした。位置情報権限またはビルドの設定を確認してください。', 'error');
    } finally {
      doing.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const latest = Math.max(lastForeground?.timestamp || 0, lastMeta?.timestamp || 0);
  const age = latest ? now - latest : Infinity;
  const freshness = !tracking ? '停止中' : age < 120000 ? '更新あり' : '位置更新が古い／未取得';
  const latestAccuracy =
    (lastForeground?.timestamp || 0) >= (lastMeta?.timestamp || 0)
      ? lastForeground?.accuracyMeters
      : lastMeta?.accuracyMeters;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>RAINBOW DRIVER / CARGO</Text>
        <Text style={styles.headline}>軽貨物ドライバー</Text>
        <Text style={styles.subhead}>iPhoneネイティブ版・バックグラウンドGPS試作</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>1. 稼働状況</Text>
        <View style={styles.choices}>
          {OPTIONS.map((option) => (
            <TouchableOpacity
              key={option.key}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => changeStatus(option.key)}
              style={[styles.option, status === option.key && styles.selected]}
            >
              <Text style={[styles.optionText, status === option.key && styles.selectedText]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.hint}>稼働可能と配送中はGPSをONにできます。休憩中・オフラインでは追跡を停止します。</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>2. GPS稼働</Text>
        <Text style={[styles.large, { color: tracking ? C.ok : C.muted }]}>
          {tracking ? 'GPS稼働中' : 'GPS停止中'}
        </Text>
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.button, (busy || tracking) && styles.disabled]} disabled={busy || tracking} onPress={startTracking}>
            <Text style={styles.buttonText}>稼働開始</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.secondary, (busy || !tracking) && styles.disabled]} disabled={busy || !tracking} onPress={stopTracking}>
            <Text style={styles.secondaryText}>GPS停止</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.message, messageType === 'error' ? styles.error : messageType === 'ok' ? styles.ok : null]}>
          {message}
        </Text>
        <TouchableOpacity accessibilityRole="button" style={styles.settings} onPress={() => Linking.openSettings()}>
          <Text style={styles.settingsText}>iPhoneの位置情報設定を開く</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>3. 測位の更新記録</Text>
        <Text style={[styles.large, { color: age < 120000 && tracking ? C.ok : C.warning }]}>{freshness}</Text>
        <View style={styles.metric}><Text style={styles.metricLabel}>最後に測位した時刻</Text><Text style={styles.metricValue}>{dateString(latest)}</Text></View>
        <View style={styles.metric}><Text style={styles.metricLabel}>推定精度</Text><Text style={styles.metricValue}>{latestAccuracy == null ? '—' : '± ' + latestAccuracy + 'm'}</Text></View>
        <View style={styles.metric}><Text style={styles.metricLabel}>背景タスク受信件数（累計）</Text><Text style={styles.metricValue}>{lastMeta?.count || 0}</Text></View>
        <TouchableOpacity onPress={readState} style={[styles.button, styles.secondary]}>
          <Text style={styles.secondaryText}>最新情報に更新</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>iPhoneのホーム画面に戻すか別アプリを使用し、数分後に戻って更新時刻と件数を確認します。停止・省電力モード・位置情報権限の変更などで更新が遅れる場合があります。</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>個人情報とテスト範囲</Text>
        <Text style={styles.hint}>
          この試作はサーバーに接続しません。位置情報の緯度・経度を保存せず、最終更新日時・精度・回数のみiPhone内に記録します。バックグラウンドGPSが受信できるかを検証するためのものです。実際の顧客依頼や予約は受け付けません。
        </Text>
        <Text style={styles.hint}>
          注意：iPhoneでアプリを強制終了した場合など、iOSの制限により測位が継続しないことがあります。
        </Text>
      </View>
      <Text style={styles.footer}>Rainbow Driver 軽貨物 / Prototype 0.1.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.pale },
  content: { paddingBottom: 30 },
  hero: { backgroundColor: C.navy, paddingHorizontal: 22, paddingTop: 78, paddingBottom: 30 },
  eyebrow: { color: '#c1cfde', fontSize: 12, letterSpacing: 2 },
  headline: { fontWeight: '800', fontSize: 29, color: C.white, marginTop: 12 },
  subhead: { color: '#d8e4ef', fontSize: 13, marginTop: 8 },
  card: { marginHorizontal: 14, marginTop: 14, padding: 18, backgroundColor: C.white, borderColor: C.line, borderWidth: 1, borderRadius: 16 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 14, color: C.navy },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { width: '48%', paddingVertical: 13, borderRadius: 10, backgroundColor: '#edf2f7', alignItems: 'center' },
  selected: { backgroundColor: C.navy },
  optionText: { fontWeight: '700', color: C.navy },
  selectedText: { color: C.white },
  hint: { marginTop: 12, fontSize: 13, color: C.muted, lineHeight: 21 },
  large: { fontSize: 21, fontWeight: '800', marginBottom: 13 },
  actions: { flexDirection: 'row', gap: 8 },
  button: { paddingVertical: 14, paddingHorizontal: 12, backgroundColor: C.navy, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flex: 1, marginTop: 8 },
  disabled: { opacity: 0.45 },
  buttonText: { color: C.white, fontWeight: '700' },
  secondary: { backgroundColor: '#e9f0f6' },
  secondaryText: { color: C.navy, fontWeight: '700' },
  message: { padding: 12, marginTop: 15, borderRadius: 10, color: '#345a80', backgroundColor: '#eef5ff', lineHeight: 21, fontSize: 13 },
  error: { color: C.red, backgroundColor: '#fff0f0' },
  ok: { color: C.ok, backgroundColor: '#eaf8f0' },
  settings: { paddingVertical: 12, alignItems: 'center', marginTop: 8 },
  settingsText: { color: C.blue, fontWeight: '600' },
  metric: { borderTopColor: C.line, borderTopWidth: 1, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  metricLabel: { color: C.muted, flex: 1, fontSize: 13 },
  metricValue: { color: C.navy, fontSize: 13, fontWeight: '700', maxWidth: '57%', textAlign: 'right' },
  footer: { textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 25 }
});
