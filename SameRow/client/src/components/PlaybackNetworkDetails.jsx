const format = (value, suffix, digits = 0) => Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : 'Unavailable';

export default function PlaybackNetworkDetails({ network, endpoint, peer, transport, transportError }) {
  const connection = globalThis.navigator?.connection;
  const direct = network?.transport === 'webrtc';
  const active = network?.requests.filter(request => request.ended === undefined).length;
  let gateway;
  try { if (endpoint) gateway = new URL(endpoint, globalThis.location?.href).host; } catch { /* No gateway supplied by embedded player. */ }
  return <div className="playback-network-details">
    <dl>
      {transport && <div><dt>Media transport</dt><dd>{transport}</dd></div>}
      {transportError && <div><dt>Transport detail</dt><dd>{transportError}</dd></div>}
      {peer && <>
        <div><dt>WebRTC setup / connected time</dt><dd>{format(peer.setupMs / 1000, ' s setup', 2)} · {format(peer.connectedMs / 1000, ' s connected')}</dd></div>
        <div><dt>WebRTC path</dt><dd>{peer.route || 'Awaiting ICE route'}{peer.protocol ? ` · ${peer.protocol.toUpperCase()}` : ''} · {format(peer.rtt * 1000, ' ms RTT')}</dd></div>
        <div><dt>WebRTC receive rate</dt><dd>{format(peer.speed / 1e6, ' Mbps', 2)} · {peer.activeRequests} in flight</dd></div>
      </>}
      <div><dt>Browser network</dt><dd>{globalThis.navigator?.onLine === false ? 'Offline' : 'Online (browser signal)'}</dd></div>
      <div><dt>Media gateway</dt><dd>{gateway || 'Managed by Jellyfin Web'}</dd></div>
      <div><dt>Connection estimate</dt><dd>{connection ? `${connection.effectiveType || connection.type || 'Unknown type'} · ${format(connection.downlink, ' Mbps', 1)} · ${format(connection.rtt, ' ms RTT')}${connection.saveData ? ' · Data saver' : ''}` : 'Not exposed by this browser'}</dd></div>
      <div><dt>Media received this stream</dt><dd>{network ? `${(network.transferred / 1048576).toFixed(2)} MiB · ${active} in flight · ${network.completed} completed · ${network.failures} failed requests` : 'Request measurements not exposed by this player'}</dd></div>
    </dl>
    {network?.requests?.length > 0 && <div className="playback-network-table"><table><caption>Recent media requests · {direct ? 'home sender' : 'gateway'} → this device</caption><thead><tr><th>Request</th><th>Result</th><th>Wait / total</th><th>Received / rate</th></tr></thead><tbody>{network.requests.slice(-6).reverse().map(request => <tr key={`${request.started}:${request.kind}`}><td>{request.kind}{request.retries > 0 && <small>{request.retries} retries</small>}</td><td>{request.status ? `HTTP ${request.status} · ` : ''}{request.state}</td><td>{format(request.ttfb, ' ms first byte')}<small>{format(request.duration / 1000, ' s total', 1)}</small></td><td>{format(request.bytes / 1024, ' KiB', 1)}{request.total > request.bytes && ` / ${format(request.total / 1024, ' KiB', 1)}`}<small>{format(request.transferRate === null ? undefined : request.transferRate / 1e6, ' Mbps', 2)}</small></td></tr>)}</tbody></table></div>}
    <p>First byte includes the wait for Jellyfin. Transfer rate measures delivery after the first byte.</p>
  </div>;
}
