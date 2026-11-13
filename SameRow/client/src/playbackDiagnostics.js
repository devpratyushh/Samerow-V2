// Keep diagnostics useful without displaying request URLs or playback credentials.
export function hlsFailure(data = {}) {
  const detail = /^[a-zA-Z0-9_-]{1,96}$/.test(data.details || '') ? data.details : 'HLS request failed';
  const status = Number(data.response?.code);
  return `${detail}${Number.isInteger(status) && status >= 100 && status <= 599 ? ` · HTTP ${status}` : ''}`;
}

export function mediaFailure(code) {
  return ({ 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' })[code] || 'No media error reported';
}

export function mediaReadiness(value) {
  return ['No media metadata', 'Metadata loaded', 'Current frame available', 'Future frames available', 'Enough data to play'][value] || 'Unknown';
}
