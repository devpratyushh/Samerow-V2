const ICE_SERVERS = (import.meta.env?.VITE_JELLYFIN_DIRECT_STUN || 'stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478')
  .split(',').map(url => url.trim()).filter(url => /^stuns?:/.test(url)).map(urls => ({ urls }));
const MAX_RESPONSE = 64 * 1024 * 1024;
const MAX_IN_FLIGHT = 96 * 1024 * 1024;
const mediaError = (message, code = 0) => Object.assign(new Error(message), { code });

function waitUntil(check, signal, timeout) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const done = (error, value) => {
      clearInterval(timer); signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => done(mediaError('Direct connection cancelled'));
    const tick = () => {
      try {
        const result = check();
        if (result) done(null, result);
        else if (performance.now() - start >= timeout) done(mediaError('Direct ICE connection timed out'));
      } catch (error) { done(error); }
    };
    const timer = setInterval(tick, 75);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else tick();
  });
}

export function createDirectMedia(socket, access, onStatus, onFailure) {
  const controller = new AbortController();
  const { signal } = controller;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel('samerow-hls-v1');
  channel.binaryType = 'arraybuffer';
  const requests = new Map();
  let peerId, id = 0, renewal, disconnected, closed = false, failed = false;
  let lastError = '', firstByte = null, bytes = 0, segmentsRequested = 0, segmentsCompleted = 0;
  let timeouts = 0, rateBytes = 0, rateTime = performance.now();
  let buffered = 0, validated = false;
  const segmentRates = [];
  const started = rateTime;
  const rpc = (event, data) => socket.timeout(3500).emitWithAck(event, data);
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    clearInterval(renewal); clearTimeout(disconnected);
    socket.off('disconnect', handleDisconnect);
    if (peerId && socket.connected) socket.emit('jellyfin-direct-close', { id: peerId });
    for (const request of requests.values()) request.finish(mediaError('Direct connection closed'));
    pc.close();
  };
  const fail = reason => {
    if (closed || failed) return;
    failed = true; lastError = reason;
    onFailure(reason);
    close();
  };
  const handleDisconnect = () => fail('Room signaling disconnected');
  socket.on('disconnect', handleDisconnect);
  const sendCancel = requestId => {
    if (channel.readyState === 'open') {
      try { channel.send(JSON.stringify({ op: 'cancel', id: requestId })); } catch { /* Closing. */ }
    }
  };
  const request = (asset, options = {}) => new Promise((resolve, reject) => {
    if (closed || channel.readyState !== 'open' || requests.size >= 6) {
      reject(mediaError('Direct media channel unavailable'));
      return;
    }
    const requestId = ++id;
    const entry = { asset, status: null, headers: {}, chunks: [], size: 0, next: 0, progress: options.progress };
    const cancel = () => { sendCancel(requestId); entry.finish(mediaError('Direct request cancelled')); };
    const timer = setTimeout(() => {
      sendCancel(requestId);
      lastError = 'Direct media request timed out';
      entry.finish(mediaError(lastError, 408));
      if (++timeouts >= 2) fail('Repeated direct media timeouts');
    }, options.timeout || 12000);
    entry.finish = (error, result) => {
      if (!requests.delete(requestId)) return;
      buffered -= entry.size;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(result);
    };
    requests.set(requestId, entry);
    if (options.segment) segmentsRequested++;
    entry.segment = options.segment;
    if (options.signal?.aborted) { cancel(); return; }
    options.signal?.addEventListener('abort', cancel, { once: true });
    try { channel.send(JSON.stringify({ op: 'get', id: requestId, asset, range: options.range })); }
    catch { entry.finish(mediaError('Direct request could not be sent')); }
  });
  channel.onmessage = ({ data }) => {
    try {
      if (typeof data === 'string') {
        const frame = JSON.parse(data), entry = requests.get(frame.id);
        if (!entry) return;
        if (frame.op === 'headers' && entry.status === null) {
          entry.status = frame.status; entry.headers = frame.headers || {};
          return;
        }
        if (frame.op === 'error') {
          lastError = 'Home sender could not deliver this resource';
          entry.finish(mediaError(lastError)); return;
        }
        if (frame.op !== 'end' || entry.status === null) throw mediaError('Invalid direct media frame');
        if (entry.status < 200 || entry.status >= 300) {
          entry.finish(mediaError(`Jellyfin returned HTTP ${entry.status}`, entry.status)); return;
        }
        if (entry.headers['content-length'] && Number(entry.headers['content-length']) !== entry.size) throw mediaError('Incomplete direct media response');
        const body = new Uint8Array(entry.size);
        let offset = 0;
        for (const chunk of entry.chunks) { body.set(chunk, offset); offset += chunk.length; }
        if (entry.segment) {
          segmentsCompleted++; timeouts = 0;
          const transferMs = entry.last - entry.first;
          if (transferMs >= 20) {
            segmentRates.push(entry.size * 8000 / transferMs);
            if (segmentRates.length > 3) segmentRates.shift();
          }
        }
        if (entry.asset === 'manifest' && body.length) validated = true;
        entry.finish(null, { data: body, status: entry.status, headers: entry.headers });
        return;
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength <= 8 || data.byteLength > 16384) throw mediaError('Invalid direct media frame');
      const frame = new DataView(data), entry = requests.get(frame.getUint32(0));
      if (!entry) return;
      if (entry.status === null || frame.getUint32(4) !== entry.next++) throw mediaError('Out-of-order direct media response');
      const chunk = new Uint8Array(data, 8);
      entry.size += chunk.length;
      buffered += chunk.length;
      if (entry.size > MAX_RESPONSE || buffered > MAX_IN_FLIGHT) throw mediaError('Direct media response exceeds its buffer limit');
      entry.chunks.push(chunk); bytes += chunk.length;
      entry.last = performance.now();
      entry.first ??= entry.last;
      firstByte ??= entry.last - started;
      entry.progress?.(entry.size);
    } catch (error) { fail(error.code === 0 ? error.message : 'Invalid direct media response'); }
  };
  channel.onclose = () => fail('Direct media channel closed');
  channel.onerror = () => fail('Direct media channel failed');
  pc.onconnectionstatechange = () => {
    clearTimeout(disconnected);
    if (closed) return;
    if (pc.connectionState === 'failed') fail('Direct ICE connection failed');
    if (pc.connectionState === 'disconnected') {
      onStatus('Reconnecting to home Jellyfin…');
      disconnected = setTimeout(() => fail('Direct connection did not recover'), 4500);
    }
    if (validated && pc.connectionState === 'connected' && channel.readyState === 'open') onStatus('Direct WebRTC connected');
  };
  return {
    request, close,
    isSlowFor: bitrate => bitrate > 0 && segmentRates.length === 3 && segmentRates.every(rate => rate < bitrate * 0.8),
    async connect(settings, abort) {
      abort?.addEventListener('abort', close, { once: true });
      if (abort?.aborted) close();
      onStatus('Negotiating direct connection…');
      await pc.setLocalDescription(await pc.createOffer());
      try { await waitUntil(() => pc.iceGatheringState === 'complete', signal, 2200); }
      catch (error) { if (signal.aborted) throw error; }
      const reply = await rpc('jellyfin-direct-offer', { ...access, sdp: pc.localDescription.sdp, settings });
      if (!reply?.id) throw mediaError(reply?.error || 'Home sender unavailable', reply?.status);
      peerId = reply.id;
      if (closed) {
        if (socket.connected) socket.emit('jellyfin-direct-close', { id: peerId });
        throw mediaError('Direct connection cancelled');
      }
      let answer;
      const deadline = performance.now() + 6000;
      while (!answer && !signal.aborted && performance.now() < deadline) {
        const result = await rpc('jellyfin-direct-answer', { id: peerId });
        answer = result?.sdp;
        if (!answer) {
          const pollAfter = Math.min(deadline, performance.now() + 350);
          await waitUntil(() => performance.now() >= pollAfter, signal, 1000);
        }
      }
      if (!answer) throw mediaError('Home sender did not answer');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await waitUntil(() => channel.readyState === 'open', signal, 4000);
      renewal = setInterval(() => {
        rpc('jellyfin-direct-renew', { id: peerId }).then(reply => {
          if (!reply?.ok) fail('Direct playback access ended');
        }).catch(() => fail('Could not renew direct playback access'));
      }, 7000);
      onStatus('Testing direct media transport…');
    },
    async snapshot() {
      const now = performance.now();
      const speed = (bytes - rateBytes) * 8000 / Math.max(1, now - rateTime);
      rateTime = now; rateBytes = bytes;
      let route, rtt;
      try {
        const stats = await pc.getStats();
        const transport = [...stats.values()].find(report => report.selectedCandidatePairId);
        const pair = stats.get(transport?.selectedCandidatePairId) ||
          [...stats.values()].find(report => report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded');
        if (pair) {
          route = [stats.get(pair.localCandidateId)?.candidateType, stats.get(pair.remoteCandidateId)?.candidateType].filter(Boolean).join(' → ');
          rtt = pair.currentRoundTripTime;
        }
      } catch { /* Stats are optional. */ }
      return { bytes, speed, segmentsRequested, segmentsCompleted, firstByte, route, rtt, lastError };
    },
  };
}

const freshStats = () => ({ aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
  loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } });

export function directLoader(peer, manifestURL, manifest) {
  const manifestHref = new URL(manifestURL, globalThis.location.href).href;
  const origin = new URL(manifestHref).origin;
  let initialManifest = manifest;
  return class {
    stats = freshStats();
    context = null;
    headers = {};
    active = false;

    load(context, config, callbacks) {
      this.context = context;
      this.callbacks = callbacks;
      this.active = true;
      this.controller = new AbortController();
      const { signal } = this.controller;
      const { stats } = this;
      stats.loading.start = performance.now();
      const url = new URL(context.url, manifestHref);
      const isManifest = url.href === manifestHref;
      const asset = url.origin === origin && /^\/samerow-direct\/asset\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      const range = Number.isFinite(context.rangeStart) && context.rangeEnd > context.rangeStart
        ? `bytes=${context.rangeStart}-${context.rangeEnd - 1}` : undefined;
      const progress = bytes => {
        stats.loading.first ||= performance.now();
        stats.loaded = bytes;
        // HLS.js receives one complete resource. The diagnostic wrapper can
        // observe progress without activating HLS.js's progressive parser.
        callbacks.onTransferProgress?.(stats);
      };
      const response = isManifest && initialManifest ? Promise.resolve(initialManifest)
        : asset || isManifest ? peer.request(asset || 'manifest', { range, signal, progress,
          timeout: Math.min(16000, config.timeout || 16000), segment: !!context.frag })
          : Promise.reject(mediaError('Unexpected direct media URL'));
      if (isManifest) initialManifest = null;
      response.then(result => {
        if (signal.aborted) return;
        this.active = false;
        this.headers = result.headers;
        stats.loading.first ||= isManifest ? stats.loading.start : performance.now();
        stats.loading.end = performance.now();
        stats.loaded = stats.total = result.data.byteLength;
        stats.bwEstimate = stats.loaded * 8000 / Math.max(1, stats.loading.end - stats.loading.first);
        const data = context.responseType === 'arraybuffer' ? result.data.buffer : new TextDecoder().decode(result.data);
        if (context.responseType === 'arraybuffer') callbacks.onProgress?.(stats, context, data, null);
        callbacks.onSuccess({ url: url.href, code: result.status, data }, stats, context, null);
      }, error => {
        if (signal.aborted) return;
        this.active = false;
        if (error.code === 408) callbacks.onTimeout(stats, context, null);
        else callbacks.onError({ code: error.code || 0, text: error.message }, context, null, stats);
      });
    }

    getResponseHeader(name) { return this.headers[name.toLowerCase()] ?? null; }
    getCacheAge() { return null; }
    abort() {
      if (!this.active) return;
      this.active = false;
      this.stats.aborted = true;
      this.controller.abort();
      this.callbacks?.onAbort?.(this.stats, this.context, null);
    }
    destroy() {
      this.active = false;
      this.controller?.abort();
      this.callbacks = null;
    }
  };
}
