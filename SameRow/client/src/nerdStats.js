export const rate = (bytes, previousBytes, milliseconds) => milliseconds > 0 && bytes >= previousBytes ? (bytes - previousBytes) * 8000 / milliseconds : null;
export const mbps = value => Number.isFinite(value) ? `${(value / 1000000).toFixed(2)} Mbps` : 'Measuring…';

// RTC timestamps are milliseconds; use deltas, never lifetime average bitrate.
export function summarizeRtp(reports, previous = new Map()) {
  const next = new Map(), rows = [];
  for (const { key, name, report } of reports) {
    report?.forEach(value => {
      if (!['inbound-rtp', 'outbound-rtp'].includes(value.type) || value.isRemote) return;
      const id = `${key}:${value.id}`;
      if (next.has(id)) return;
      next.set(id, value);
      const old = previous.get(id), sending = value.type === 'outbound-rtp';
      const bytes = sending ? value.bytesSent : value.bytesReceived;
      const before = sending ? old?.bytesSent : old?.bytesReceived;
      const packets = old ? (value.packetsReceived || 0) - (old.packetsReceived || 0) : 0;
      const lost = old ? Math.max(0, (value.packetsLost || 0) - (old.packetsLost || 0)) : 0;
      const codec = report.get(value.codecId)?.mimeType;
      const remote = report.get(value.remoteId);
      rows.push({ id, name, direction: sending ? 'Sending' : 'Receiving', kind: value.kind || value.mediaType,
        bitrate: old ? rate(bytes, before, value.timestamp - old.timestamp) : null,
        width: value.frameWidth, height: value.frameHeight, fps: value.framesPerSecond,
        loss: !sending && old && packets + lost > 0 ? lost * 100 / (packets + lost) : null,
        jitter: Number.isFinite(value.jitter) ? value.jitter * 1000 : null,
        rtt: Number.isFinite(remote?.roundTripTime) ? remote.roundTripTime * 1000 : null,
        limitation: value.qualityLimitationReason, codec,
        cap: value.targetBitrate,
      });
    });
  }
  return { rows, previous: next };
}
