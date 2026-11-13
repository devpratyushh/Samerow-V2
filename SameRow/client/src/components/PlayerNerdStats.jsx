import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { playbackStats } from '../playbackStats';
import { mediaReadiness } from '../playbackDiagnostics';
import './PlayerNerdStats.css';

const number = (value, suffix = '', digits = 1) => Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : 'Not reported';

export default function PlayerNerdStats({ videoRef, hlsRef, reported, policy, phase, stage, failure, delivery, audio, subtitle, targetTime }) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState(null);
  const previous = useRef(null);
  const collect = useEffectEvent(() => {
    const video = videoRef?.current;
    if (!video) {
      setSample(reported && Date.now() - reported.receivedAt < 15000 ? reported : null);
      return;
    }
    const now = performance.now();
    const stats = playbackStats(video);
    const old = previous.current;
    const fps = old && Number.isFinite(stats.frames) && Number.isFinite(old.frames) && stats.frames >= old.frames && now > old.at
      ? (stats.frames - old.frames) * 1000 / (now - old.at) : null;
    previous.current = { frames: stats.frames, at: now };
    const target = targetTime?.();
    setSample({ ...stats, fps, currentTime: video.currentTime, playbackRate: video.playbackRate,
      drift: Number.isFinite(target) ? video.currentTime - target : null,
      bandwidth: hlsRef?.current?.bandwidthEstimate });
  });
  useEffect(() => {
    if (!open) return;
    previous.current = null;
    collect();
    const timer = setInterval(collect, 1000);
    return () => clearInterval(timer);
  }, [open]);
  const rows = [
    ['Playback', phase || 'Not reported'],
    ['Decoded video', sample?.width && sample?.height ? `${sample.width} × ${sample.height}` : 'No decoded video reported'],
    ['Decoded frame rate', number(sample?.fps, ' fps')],
    ['Dropped / total frames', `${number(sample?.dropped, '', 0)} / ${number(sample?.frames, '', 0)}`],
    ['Buffer ahead', number(sample?.buffer, ' s')],
    ['Browser readiness', sample ? mediaReadiness(sample.readyState) : 'Awaiting report'],
    ['Playback time', number(sample?.currentTime, ' s')],
    ['Sync offset', Number.isFinite(sample?.drift) ? `${sample.drift >= 0 ? '+' : ''}${sample.drift.toFixed(2)} s (device − room)` : 'Not reported'],
    ['Playback speed', number(sample?.playbackRate, '×', 2)],
    ['Delivery requested', delivery || 'Not reported'],
    ['Source video', policy?.source?.width && policy?.source?.height ? `${policy.source.width} × ${policy.source.height}` : 'Not reported'],
    ['Source bitrate', number(policy?.source?.bitrate ? policy.source.bitrate / 1e6 : null, ' Mbps')],
    ['Quality / bitrate cap', policy ? `${policy.mode} · ${number(policy.maxBitrate / 1e6, ' Mbps')}${policy.capacityLimited ? ' · shared capacity limit' : ''}` : 'Waiting for settings'],
    ['HLS bandwidth estimate', number(Number.isFinite(sample?.bandwidth) ? sample.bandwidth / 1e6 : null, ' Mbps')],
    ['Audio / subtitles', audio || subtitle ? `${audio || 'Not reported'} / ${subtitle || 'Not reported'}` : 'Selected inside Jellyfin Web'],
    ['Last player event', stage || 'Not reported'],
    ['Last error', failure || 'None reported'],
  ];
  return <details className="player-nerd-stats" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Stats for nerds <span>· this device</span></summary>
    {open && <div className="player-nerd-stats-body"><p>{videoRef ? 'Updates every second while open.' : 'Jellyfin Web reports every 5 seconds; unavailable fields are marked.'} Bandwidth estimate is not measured movie delivery throughput.</p>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </div>}
  </details>;
}
