export function playbackStats(video) {
  if (!video) return null;
  const frames = video.getVideoPlaybackQuality?.();
  let buffer = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) buffer = video.buffered.end(i) - video.currentTime;
  }
  return { width: video.videoWidth, height: video.videoHeight, buffer, frames: frames?.totalVideoFrames ?? null,
    dropped: frames?.droppedVideoFrames ?? null, paused: video.paused, readyState: video.readyState };
}
