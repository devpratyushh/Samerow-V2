const format = (value, suffix, digits = 0) => Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : 'Unavailable';

export default function PlaybackNetworkDetails({ network, endpoint }) {
  const connection = globalThis.navigator?.connection;
  let gateway;
  try { if (endpoint) gateway = new URL(endpoint, globalThis.location?.href).host; } catch { /* No gateway supplied by embedded player. */ }
  return <div className="playback-network-details">
    <dl>
      <div><dt>Browser network</dt><dd>{globalThis.navigator?.onLine === false ? 'Offline' : 'Online (browser signal)'}</dd></div>
      <div><dt>Media gateway</dt><dd>{gateway || 'Managed by Jellyfin Web'}</dd></div>
      <div><dt>Connection estimate</dt><dd>{connection ? `${connection.effectiveType || connection.type || 'Unknown type'} · ${format(connection.downlink, ' Mbps', 1)} · ${format(connection.rtt, ' ms RTT')}${connection.saveData ? ' · Data saver' : ''}` : 'Not exposed by this browser'}</dd></div>
      <div><dt>Media received this stream</dt><dd>{network ? `${(network.transferred / 1048576).toFixed(2)} MiB · ${network.completed} completed · ${network.failures} failed requests` : 'Request measurements not exposed by this player'}</dd></div>
    </dl>
    {network?.requests?.length > 0 && <div className="playback-network-table"><table><caption>Recent media requests · gateway → this device</caption><thead><tr><th>Request</th><th>Result</th><th>Wait / total</th><th>Received / rate</th></tr></thead><tbody>{network.requests.slice(-6).reverse().map(request => <tr key={`${request.started}:${request.kind}`}><td>{request.kind}{request.retries > 0 && <small>{request.retries} retries</small>}</td><td>{request.status ? `HTTP ${request.status} · ` : ''}{request.state}</td><td>{format(request.ttfb, ' ms first byte')}<small>{format(request.duration / 1000, ' s total', 1)}</small></td><td>{format(request.bytes / 1024, ' KiB', 1)}<small>{format(Number.isFinite(request.throughput) ? request.throughput / 1e6 : null, ' Mbps', 2)}</small></td></tr>)}</tbody></table></div>}
    <p>First byte includes gateway and origin wait. Request rate includes that wait; connection estimates are browser hints. Jellyfin → gateway timing is not measured here.</p>
  </div>;
}
