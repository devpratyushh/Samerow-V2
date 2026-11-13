// Quality belongs to a viewer, never the synchronized room timeline.
const MAX_BITRATE = 1000000000;
const qualityModes = { auto: MAX_BITRATE, original: MAX_BITRATE, '4mbps': 4000000, '8mbps': 8000000, '20mbps': 20000000 };
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
function sourceInfo(state) {
  const source = state.item?.MediaSources?.find(source => source.Id === state.sourceId) || {};
  const streams = source.MediaStreams || state.item?.MediaStreams || [];
  const video = streams.find(stream => stream.Type === 'Video') || {};
  const bitrate = positive(source.Bitrate) || (positive(video.BitRate) ? streams.reduce((sum, stream) => sum + (positive(stream.BitRate) || 0), 0) : null)
    || (positive(source.Size) && positive(source.RunTimeTicks) ? source.Size * 8 * 10000000 / source.RunTimeTicks : null);
  return { bitrate, width: positive(video.Width), height: positive(video.Height) };
}
function createQualityPolicy(store, { originMbps = 0, gatewayMbps = 0 } = {}) {
  const scopes = state => ['jellyfin-gateway', `jellyfin-origin:${new URL(state.base).origin}`];
  const renew = async (viewer, state) => Promise.all(scopes(state).map(scope => store.leaseCount(scope, viewer.token)));
  return {
    renew,
    release: async (viewer, state) => Promise.all(scopes(state).map(scope => store.releaseLease(scope, viewer.token))),
    async describe(viewer, state, defaultMode = 'auto') {
      const [gatewayViewers, originViewers] = await renew(viewer, state);
      // Reserve 20% for bitrate peaks and HTTP overhead. Both limits are shared
      // across rooms and replicas using the same Redis namespace.
      const capacity = Math.min(gatewayMbps ? gatewayMbps * 800000 / gatewayViewers : MAX_BITRATE,
        originMbps ? originMbps * 800000 / originViewers : MAX_BITRATE);
      const source = sourceInfo(state);
      const originalBitrate = Math.min(MAX_BITRATE, source.bitrate ? Math.ceil(source.bitrate * 1.25) : MAX_BITRATE);
      const mode = Object.hasOwn(qualityModes, viewer.qualityMode) ? viewer.qualityMode : defaultMode;
      return { mode, revision: viewer.qualityRevision || 0, source, originalBitrate,
        maxBitrate: Math.max(1, Math.floor(Math.min(capacity, originalBitrate, qualityModes[mode]))),
        capacityLimited: capacity < originalBitrate };
    },
  };
}
function negotiateQuality(body, policy) {
  const requested = positive(body.MaxStreamingBitrate) || positive(body.DeviceProfile?.MaxStreamingBitrate) || MAX_BITRATE;
  const bitrate = Math.floor(Math.min(policy.maxBitrate, policy.mode === 'original' ? MAX_BITRATE : requested));
  return { ...body, MaxStreamingBitrate: bitrate,
    ...(body.DeviceProfile ? { DeviceProfile: { ...body.DeviceProfile, MaxStreamingBitrate: bitrate, MaxStaticBitrate: bitrate } } : {}),
  };
}
module.exports = { createQualityPolicy, sourceInfo, negotiateQuality, qualityModes };
