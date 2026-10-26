// Cap metadata/manifests before buffering. Movie bytes still use streaming.
async function readText(response, maximum = 4 * 1024 * 1024) {
  const tooLarge = () => Object.assign(new Error('Jellyfin returned too much data.'), { status: 502 });
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw tooLarge(); }
  const reader = response.body?.getReader();
  if (!reader) throw Object.assign(new Error('Jellyfin returned an empty response.'), { status: 502 });
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw tooLarge(); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
async function readJson(response) {
  const text = await readText(response);
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('This address did not return a valid Jellyfin response.'), { status: 502 }); }
}
module.exports = { readText, readJson };
