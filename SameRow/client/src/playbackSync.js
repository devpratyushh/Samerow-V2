// Server time is measured against a monotonic client clock, not the user's wall clock.
export function createServerClock() {
  let samples = [];
  return {
    sample(clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt) {
      if (![clientSentAt, clientReceivedAt, serverReceivedAt, serverSentAt].every(Number.isFinite)) return false;
      const elapsed = clientReceivedAt - clientSentAt;
      const processing = serverSentAt - serverReceivedAt;
      if (elapsed < 0 || elapsed > 10000 || processing < 0 || processing > elapsed + 1) return false;
      const rtt = Math.max(0, elapsed - processing);
      const offset = (serverReceivedAt + serverSentAt - clientSentAt - clientReceivedAt) / 2;
      samples = samples.filter(sample => clientReceivedAt - sample.at < 60000);
      // Recover from an actual server clock step without accepting a slow outlier.
      const best = samples.reduce((a, b) => !a || b.rtt < a.rtt ? b : a, null);
      if (best && rtt < 250 && Math.abs(offset - best.offset) > 1000) samples = [];
      samples.push({ offset, rtt, at: clientReceivedAt });
      samples = samples.slice(-8);
      return true;
    },
    offset(now = performance.now()) {
      const best = samples.filter(sample => now - sample.at < 60000)
        .reduce((a, b) => !a || b.rtt < a.rtt ? b : a, null);
      return best?.offset ?? null;
    },
    reset() { samples = []; }
  };
}

export function commandServerTime(state, now = performance.now()) {
  return Number.isFinite(state.serverTimeOffset) ? now + state.serverTimeOffset : undefined;
}

// Keep tiny offsets alone; only use speed changes the provider can actually play.
// YouTube commonly exposes coarse speed steps, so it usually uses the seek fallback.
export function createDriftController() {
  let driftSince = null;
  let direction = 0;
  let lastSeek = -Infinity;
  return {
    reset() { driftSince = null; direction = 0; lastSeek = -Infinity; },
    correction({ currentTime, target, playing, now, force = false, suspended = false, rates = [1] }) {
      const drift = target - currentTime;
      if (suspended || ![currentTime, target, now].every(Number.isFinite)) {
        driftSince = null;
        return { rate: 1 };
      }
      const tolerance = playing ? 0.15 : 0.08;
      if (Math.abs(drift) <= tolerance) {
        driftSince = null; direction = 0;
        return { rate: 1 };
      }
      if (force || (!playing && now - lastSeek >= 300) || (Math.abs(drift) >= 1.25 && now - lastSeek >= 2000)) {
        lastSeek = now; driftSince = null;
        return { rate: 1, seek: target };
      }
      if (!playing) return { rate: 1 };
      if (Math.sign(drift) !== direction || driftSince === null) { driftSince = now; direction = Math.sign(drift); }
      const gentleRate = rates.filter(rate => Number.isFinite(rate) && (rate - 1) * drift > 0 && Math.abs(rate - 1) <= 0.08)
        .sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1))[0];
      if (gentleRate) return { rate: gentleRate };
      if (Math.abs(drift) >= 0.3 && now - driftSince >= 1500 && now - lastSeek >= 3000) {
        lastSeek = now; driftSince = null;
        return { rate: 1, seek: target };
      }
      return { rate: 1 };
    }
  };
}
