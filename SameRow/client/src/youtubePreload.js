let provider;

// Warm connections and the small provider chunk while the share form is open.
export function preloadYouTube() {
  for (const href of ['https://www.youtube.com', 'https://i.ytimg.com']) {
    if (document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'preconnect'; link.href = href;
    document.head.append(link);
  }
  if (!document.head.querySelector('link[data-youtube-api]')) {
    const link = document.createElement('link');
    link.rel = 'preload'; link.as = 'script';
    link.href = 'https://www.youtube.com/iframe_api';
    link.dataset.youtubeApi = '';
    document.head.append(link);
  }
  provider ??= import('youtube-video-element/react').catch(() => { provider = null; });
  return provider;
}
