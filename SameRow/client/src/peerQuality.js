// Bound total upload as the mesh grows. Each peer otherwise gets a full camera copy.
export function mediaBudget(participants, screen = false, mode = 'balanced') {
  if (mode === 'high') return screen
    ? { bitrate: 6000000, width: 1920, height: 1080, frameRate: 30 }
    : { bitrate: 4000000, width: 1920, height: 1080, frameRate: 30 };
  const copies = Math.max(1, participants - 1);
  if (screen) return { bitrate: Math.max(180000, Math.floor(2400000 / copies)), width: participants > 5 ? 960 : 1280, height: participants > 5 ? 540 : 720, frameRate: 15 };
  return { bitrate: Math.max(70000, Math.floor(1200000 / copies)), width: participants > 8 ? 256 : participants > 3 ? 320 : 640, height: participants > 8 ? 144 : participants > 3 ? 180 : 360, frameRate: participants > 8 ? 12 : participants > 3 ? 15 : 20 };
}

const pending = new WeakMap();
export function tunePeer(peer, participants, screen = false, mode = 'balanced') {
  // simple-peer exposes its RTCPeerConnection here; contain that dependency in one module.
  const connection = peer?._pc;
  if (!connection || peer.destroyed || pending.has(peer)) return;
  const task = (async () => {
    const budget = mediaBudget(participants, screen, mode);
    // The WebRTC encoder already adapts to CPU/network pressure. Reducing its
    // ceiling again from its own stats traps recovering links at poor quality.
    for (const sender of connection.getSenders()) {
      if (!sender.track || !sender.getParameters || !sender.setParameters) continue;
      const parameters = sender.getParameters();
      // Wait for negotiation to establish encodings instead of fabricating an RID.
      if (!parameters.encodings?.length) continue;
      for (const encoding of parameters.encodings) {
        if (sender.track.kind === 'video') {
          const width = sender.track.getSettings?.().width || budget.width;
          encoding.maxBitrate = budget.bitrate;
          encoding.maxFramerate = budget.frameRate;
          encoding.scaleResolutionDownBy = Math.max(1, width / budget.width);
        } else encoding.maxBitrate = 32000;
      }
      if (sender.track.kind === 'video') parameters.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
      try { await sender.setParameters(parameters); } catch { /* Retry after negotiation on the next poll. */ }
    }
  })().finally(() => pending.delete(peer));
  pending.set(peer, task);
}
