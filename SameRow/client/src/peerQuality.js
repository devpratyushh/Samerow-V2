// Bound total upload as the mesh grows. Each peer otherwise gets a full camera copy.
export function mediaBudget(participants, screen = false) {
  const copies = Math.max(1, participants - 1);
  if (screen) return { bitrate: Math.max(180000, Math.floor(2400000 / copies)), width: participants > 5 ? 960 : 1280, height: participants > 5 ? 540 : 720, frameRate: 15 };
  return { bitrate: Math.max(70000, Math.floor(1200000 / copies)), width: participants > 8 ? 256 : participants > 3 ? 320 : 640, height: participants > 8 ? 144 : participants > 3 ? 180 : 360, frameRate: participants > 8 ? 12 : participants > 3 ? 15 : 20 };
}

const pending = new WeakMap();
export function tunePeer(peer, participants, screen = false) {
  // simple-peer exposes its RTCPeerConnection here; contain that dependency in one module.
  const connection = peer?._pc;
  if (!connection || peer.destroyed || pending.has(peer)) return;
  const task = (async () => {
    const budget = mediaBudget(participants, screen);
    let congested = false;
    try {
      const stats = await connection.getStats();
      stats.forEach(report => { if (report.type === 'outbound-rtp' && report.kind === 'video' && ['bandwidth', 'cpu'].includes(report.qualityLimitationReason)) congested = true; });
    } catch { /* Statistics are optional while connecting. */ }
    for (const sender of connection.getSenders()) {
      if (!sender.track || !sender.getParameters || !sender.setParameters) continue;
      const parameters = sender.getParameters();
      // Wait for negotiation to establish encodings instead of fabricating an RID.
      if (!parameters.encodings?.length) continue;
      for (const encoding of parameters.encodings) {
        if (sender.track.kind === 'video') {
          const width = sender.track.getSettings?.().width || budget.width;
          encoding.maxBitrate = Math.round(budget.bitrate * (congested ? 0.7 : 1));
          encoding.maxFramerate = congested ? Math.min(12, budget.frameRate) : budget.frameRate;
          encoding.scaleResolutionDownBy = Math.max(1, width / budget.width);
        } else encoding.maxBitrate = 32000;
      }
      if (sender.track.kind === 'video') parameters.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
      try { await sender.setParameters(parameters); } catch { /* Retry after negotiation on the next poll. */ }
    }
  })().finally(() => pending.delete(peer));
  pending.set(peer, task);
}
