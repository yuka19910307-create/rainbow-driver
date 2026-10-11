import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Define at module scope, before React mounts, so iOS can wake the task.
export const CARGO_TASK = 'rainbow-cargo-driver-location-v1';
export const CARGO_ACTIVE_KEY = 'rainbow-cargo-background-enabled-v1';
export const CARGO_FIX_META_KEY = 'rainbow-cargo-last-fix-meta-v1';

// Privacy first: store only update time, accuracy and event count.
// Exact latitude/longitude is neither persisted nor sent anywhere in this pilot.
TaskManager.defineTask(CARGO_TASK, async ({ data, error }) => {
  try {
    if (error) {
      await AsyncStorage.setItem('rainbow-cargo-last-background-error', String(error.message || 'Unknown location error'));
      return;
    }
    if (await AsyncStorage.getItem(CARGO_ACTIVE_KEY) !== 'true') return;
    const locations = Array.isArray(data?.locations) ? data.locations : [];
    if (locations.length === 0) return;
    const latest = locations[locations.length - 1];
    if (!latest || !Number.isFinite(latest.timestamp)) return;
    const prevText = await AsyncStorage.getItem(CARGO_FIX_META_KEY);
    let previous = {};
    try { previous = JSON.parse(prevText || '{}') || {}; } catch {}
    const record = {
      timestamp: latest.timestamp,
      accuracyMeters: typeof latest.coords?.accuracy === 'number' ? Math.round(latest.coords.accuracy) : null,
      count: (Number(previous.count) || 0) + locations.length,
      source: 'background-task'
    };
    await AsyncStorage.setItem(CARGO_FIX_META_KEY, JSON.stringify(record));
  } catch (e) {
    // Do not surface precise location in logs if storage is unavailable.
    console.warn('Cargo background location task storage error');
  }
});
