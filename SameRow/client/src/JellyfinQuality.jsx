import './JellyfinQuality.css';

export default function JellyfinQuality({ policy, select, saving, error }) {
  return <div className="jellyfin-quality">
    <label>Quality on this device<select aria-label="Quality on this device" value={policy?.mode || 'auto'} disabled={!policy || saving} onChange={event => select(event.target.value)}>
      <option value="auto">Auto</option><option value="original">Original</option>
    </select></label>
    <small>{policy?.source?.height ? `Source: ${policy.source.height}p. ` : ''}{policy?.capacityLimited ? `Shared bandwidth limit: ${(policy.maxBitrate / 1000000).toFixed(1)} Mbps.` : policy?.mode === 'original' ? 'Original video when supported by your device and selected subtitles.' : 'Adapts to your connection and device.'}</small>
    {error && <small role="alert">{error}</small>}
  </div>;
}
