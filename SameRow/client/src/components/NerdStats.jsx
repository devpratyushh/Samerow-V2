import { useEffect, useState } from 'react';
import { mbps, rate, summarizeRtp } from '../nerdStats';
import './NerdStats.css';

export default function NerdStats({ socket, roomId, mediaMode, peersRef, groupCallRef, localStream, qualityMode, onQualityChange }) {
  const [stats, setStats] = useState({ rows: [] });
  const [delivery, setDelivery] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let closed = false, running = false, previous = new Map(), lastDelivery;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const sources = mediaMode === 'livekit' ? await groupCallRef.current?.getStats() || [] : await Promise.all(peersRef.current.filter(person => person.peer?._pc && !person.peer.destroyed).map(async person => ({
          key: `${person.peerID}:${person.isScreenShare ? person.screenOwner || 'screen' : 'camera'}`,
          name: `${person.userName || 'Guest'}${person.isScreenShare ? ' · screen' : ''}`,
          report: await person.peer._pc.getStats().catch(() => null),
        })));
        if (closed) return;
        const summary = summarizeRtp(sources, previous); previous = summary.previous; setStats({ ...summary, capture: localStream?.getVideoTracks()[0]?.getSettings?.() });
        socket.timeout(4000).emit('jellyfin-stats', roomId, (failure, snapshot) => {
          if (closed) return;
          setError(failure || snapshot?.error ? 'Movie delivery stats unavailable. Check that the server is updated.' : '');
          if (failure || snapshot?.error) { lastDelivery = null; setDelivery(null); return; }
          const old = lastDelivery;
          lastDelivery = snapshot;
          setDelivery(snapshot ? { ...snapshot, viewers: snapshot.viewers.map(viewer => ({ ...viewer,
            bitrate: old?.sessionId === snapshot.sessionId ? rate(viewer.bytes, old.viewers.find(value => value.id === viewer.id)?.bytes ?? viewer.bytes, snapshot.sampledAt - old.sampledAt) : null,
          })) } : null);
        });
      } catch { if (!closed) setError('Call stats temporarily unavailable.'); }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [socket, roomId, mediaMode, peersRef, groupCallRef, localStream]);
  const total = direction => stats.rows.filter(row => row.direction === direction && Number.isFinite(row.bitrate)).reduce((sum, row) => sum + row.bitrate, 0);
  return <div className="nerd-stats">
    <p>{mediaMode === 'livekit' ? 'LiveKit SFU · upload once per published layer' : 'Peer mesh · a separate upload for each receiver'}. Updates every 5 seconds while open.</p>
    {mediaMode === 'mesh' && <label>Call quality on this device<select aria-label="Call quality on this device" value={qualityMode} onChange={event => onQualityChange(event.target.value)}><option value="balanced">Balanced upload</option><option value="high">High quality (default)</option></select></label>}
    {stats.capture?.width && <p>Camera capture / your preview: <strong>{stats.capture.width}×{stats.capture.height}{stats.capture.frameRate ? ` · ${Math.round(stats.capture.frameRate)} fps` : ''}</strong></p>}
    <p>Call upload <strong>{stats.rows.some(row => row.bitrate !== null) ? mbps(total('Sending')) : 'Measuring…'}</strong> · download <strong>{stats.rows.some(row => row.bitrate !== null) ? mbps(total('Receiving')) : 'Measuring…'}</strong></p>
    <div className="nerd-table-wrap"><table><caption>Call tracks measured on this device</caption><thead><tr><th>Peer / track</th><th>Direction</th><th>Bitrate</th><th>Video / codec</th><th>Network / limit</th></tr></thead><tbody>{stats.rows.map(row => <tr key={row.id}><td>{row.name}<small>{row.kind}</small></td><td>{row.direction}</td><td>{mbps(row.bitrate)}</td><td>{row.width ? `${row.width}×${row.height}` : '—'}{Number.isFinite(row.fps) ? ` · ${row.fps} fps` : ''}<small>{row.codec || 'Codec unavailable'}</small></td><td>{row.loss !== null ? `${row.loss.toFixed(1)}% loss` : '—'}{row.jitter !== null && <small>{row.jitter.toFixed(0)} ms jitter</small>}{row.rtt !== null && <small>{row.rtt.toFixed(0)} ms RTT</small>}{row.limitation && <small>Encoder: {row.limitation}</small>}</td></tr>)}</tbody></table></div>
    {!stats.rows.length && <p>No active call tracks yet.</p>}
    {delivery && <><h3>Jellyfin delivery</h3><p>Origin → gateway → viewers: <strong>{delivery.viewers.some(viewer => viewer.bitrate !== null) ? mbps(delivery.viewers.reduce((sum, viewer) => sum + (viewer.bitrate || 0), 0)) : 'Measuring…'}</strong> for current room members.</p><div className="nerd-table-wrap"><table><thead><tr><th>Viewer</th><th>Delivery rate</th><th>Transferred</th><th>Playback reported by viewer</th></tr></thead><tbody>{delivery.viewers.map(viewer => <tr key={viewer.id}><td>{viewer.name}{viewer.id === socket.id ? ' (you)' : ''}</td><td>{mbps(viewer.bitrate)}</td><td>{(viewer.bytes / 1048576).toFixed(1)} MiB</td><td>{viewer.playback ? <>{viewer.playback.width || 0}×{viewer.playback.height || 0}<small>{viewer.playback.buffer?.toFixed(1) ?? "—"} s buffered · {viewer.playback.paused ? "paused" : "playing"}</small><small>{viewer.playback.dropped ?? "—"} dropped / {viewer.playback.frames ?? "—"} frames</small></> : "Awaiting viewer report"}</td></tr>)}</tbody></table></div><p>Media bytes measured at the gateway, including prefetch and retries; this is delivery throughput, not encoded movie bitrate or proof of decoding. The native plugin uses the same measurement. Fully buffered viewers may show 0 Mbps.</p></>}
    <p>Mesh video can soften when upload is divided among peers. High quality allows 1080p cameras and screen sharing; CPU and network congestion can still reduce quality. Jellyfin quality is controlled separately in the movie’s Quality menu. YouTube downloads directly from YouTube.</p>
    {error && <p role="status">{error}</p>}
  </div>;
}
