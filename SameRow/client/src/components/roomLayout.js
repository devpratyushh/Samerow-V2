// Focus is a local presentation preference, never a room playback command.
export function resolveSource(selected, sources) {
  if (sources.some(source => source.id === selected)) return selected;
  return sources.find(source => source.id !== 'people')?.id || 'people';
}
export function gridColumns(count, width, height) {
  if (count < 2) return 1;
  const gap = 12;
  let best = { columns: 1, area: 0 };
  for (let columns = 1; columns <= Math.min(count, 4); columns += 1) {
    const rows = Math.ceil(count / columns);
    const tileWidth = (width - gap * (columns - 1)) / columns;
    const tileHeight = (height - gap * (rows - 1)) / rows;
    if (tileWidth < 140 && columns > 1) continue;
    const videoWidth = Math.min(tileWidth, tileHeight * 16 / 9);
    const area = videoWidth * videoWidth * 9 / 16;
    if (area > best.area) best = { columns, area };
  }
  return best.columns;
}
export function initials(name = '') {
  return name.trim().split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase() || '?';
}
export function formatTime(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const tail = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
}
