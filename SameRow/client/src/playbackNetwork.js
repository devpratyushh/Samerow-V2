// Keep only diagnostic measurements: request paths contain viewer credentials.
export function createPlaybackNetwork(now = () => performance.now(), transport) {
  let requests = [], transferred = 0, completed = 0, failures = 0;
  return {
    begin(kind) {
      const request = { kind, started: now(), state: 'Waiting for response', bytes: 0, retries: 0 };
      requests.push(request);
      requests = requests.slice(-12);
      return (state, stats, status) => {
        const bytes = Number.isFinite(stats?.loaded) ? stats.loaded : request.bytes;
        transferred += Math.max(0, bytes - request.bytes);
        request.bytes = bytes;
        if (Number.isFinite(stats?.total) && stats.total > 0) request.total = stats.total;
        request.retries = stats?.retry || 0;
        request.state = state;
        if (Number.isInteger(status) && status >= 100 && status <= 599) request.status = status;
        const timing = stats?.loading;
        if (timing?.first > timing?.start) request.ttfb = timing.first - timing.start;
        if (timing?.end > timing?.start) request.loadDuration = timing.end - timing.start;
        if (['Complete', 'Failed', 'Timed out', 'Aborted'].includes(state) && !request.ended) {
          request.ended = now();
          if (state === 'Complete') completed++;
          if (state === 'Failed' || state === 'Timed out') failures++;
        }
      };
    },
    snapshot() {
      const time = now();
      return { ...(transport ? { transport } : {}), transferred, completed, failures, requests: requests.map(request => {
        const duration = request.loadDuration ?? (request.ended ?? time) - request.started;
        const transferDuration = Number.isFinite(request.ttfb) ? duration - request.ttfb : 0;
        return { ...request, duration, transferRate: transferDuration > 0 && request.bytes > 0 ? request.bytes * 8000 / transferDuration : null, throughput: request.state === 'Complete' && duration > 0 ? request.bytes * 8000 / duration : null };
      }) };
    },
  };
}

export function diagnosticLoader(BaseLoader, network) {
  return class extends BaseLoader {
    load(context, config, callbacks) {
      const kind = context.frag?.sn === 'initSegment' ? 'Init segment'
        : Number.isInteger(context.frag?.sn) ? `Segment ${context.frag.sn}`
        : context.type || 'media';
      const update = network.begin(kind);
      const wrapped = { ...callbacks, onTransferProgress: stats => update('Downloading', stats) };
      for (const [name, state] of Object.entries({ onSuccess: 'Complete', onProgress: 'Downloading', onError: 'Failed', onTimeout: 'Timed out', onAbort: 'Aborted' })) {
        wrapped[name] = (...args) => {
          const stats = name === 'onSuccess' ? args[1] : name === 'onError' ? args[3] : args[0];
          update(state, stats, ['onSuccess', 'onError'].includes(name) ? args[0]?.code : null);
          callbacks[name]?.(...args);
        };
      }
      super.load(context, config, wrapped);
    }
  };
}

export function networkDiagnosis(network) {
  const active = network?.requests?.filter(request => !request.ended).at(-1);
  const sender = network?.transport === 'webrtc' ? 'the home sender' : 'the media gateway';
  if (active) return active.bytes > 0 ? `Receiving ${active.kind} · ${(active.bytes / 1024).toFixed(0)} KiB${active.total ? ` / ${(active.total / 1024).toFixed(0)} KiB` : ''} downloaded` : `Waiting for ${sender} to respond to ${active.kind} · ${(active.duration / 1000).toFixed(1)}s. No response bytes yet.`;
  const last = network?.requests?.at(-1);
  if (last?.state === 'Failed' || last?.state === 'Timed out') return `${last.kind} ${last.state.toLowerCase()}${last.status ? ` · HTTP ${last.status}` : ''}. Check ${sender} and Jellyfin.`;
  if (last?.state === 'Complete') return 'Media requests are completing. Waiting for the player to buffer and decode video.';
  return 'Waiting for media request measurements.';
}
