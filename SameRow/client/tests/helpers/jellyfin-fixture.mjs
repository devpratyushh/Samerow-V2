import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function jellyfinFixture({ media = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'samerow-jellyfin-'));
  if (media) {
    const ffmpeg = process.env.FFMPEG_PATH || ['/Users/pratyush/Documents/ChatGPT/Samerow/jellyfin-sandbox/ffmpeg/ffmpeg','/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg'].find(existsSync) || 'ffmpeg';
    for (const audio of [1, 2]) {
      await mkdir(join(directory,String(audio)));
      await exec(ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=12','-f','lavfi','-i',`sine=frequency=${audio===1?440:660}:sample_rate=48000`,'-t','65','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','48','-sc_threshold','0','-c:a','aac','-b:a','64k','-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_segment_filename',join(directory,String(audio),'segment%d.ts'),join(directory,String(audio),'main.m3u8')]);
    }
  }
  const requests=[];
  const controls={delay:0,invalid:false,redirect:false,external:false};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');
    const authorized = req.headers['x-emby-token'] === 'fixture-token' || /(?:^|[,\s])Token="fixture-token"(?:,|\s|$)/.test(req.headers.authorization || '');
    requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),authorized,method:req.method});
    if(!authorized){res.writeHead(401).end();return;}
    if(url.pathname==='/Items'){
      await new Promise(resolve=>setTimeout(resolve,controls.delay));
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({Items:controls.invalid?[]:[{Id:'fixture-video',Name:'Multitrack fixture',RunTimeTicks:650000000,MediaSources:[{Id:'source',Bitrate:40000000,RunTimeTicks:650000000,MediaStreams:[{Index:0,Type:'Video',Codec:'h264',Width:3840,Height:2160},{Index:1,Type:'Audio',DisplayTitle:'English',Language:'eng',IsDefault:true},{Index:2,Type:'Audio',DisplayTitle:'Spanish',Language:'spa'},{Index:3,Type:'Subtitle',DisplayTitle:'English captions',Language:'en',IsTextSubtitle:true},{Index:4,Type:'Subtitle',DisplayTitle:'Spanish captions',Language:'es',IsTextSubtitle:true},{Index:5,Type:'Subtitle',DisplayTitle:'Image captions',IsTextSubtitle:false,Codec:'pgssub'}]}]}]}));return;
    }
    if(url.pathname==='/Videos/ActiveEncodings'){res.writeHead(204).end();return;}
    if(url.pathname.endsWith('master.m3u8')){
      if(controls.redirect){res.writeHead(302,{Location:'http://example.com/private'}).end();return;}
      res.setHeader('Content-Type','application/vnd.apple.mpegurl');
      res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2"\n${controls.external?'https://example.com/private.m3u8':`/Videos/fixture-video/hls/${url.searchParams.get('AudioStreamIndex')||1}/main.m3u8?api_key=must-not-leak`}\n`);return;
    }
    if(url.pathname.endsWith('.vtt')){
      res.setHeader('Content-Type','text/vtt');res.end(`WEBVTT\n\n00:00.000 --> 01:05.000\n${url.pathname.includes('/4/')?'Hola desde SameRow':'Hello from SameRow'}\n`);return;
    }
    const file=url.pathname.match(/^\/Videos\/fixture-video\/hls\/([12])\/(main.m3u8|segment\d+\.ts)$/);
    if(file){
      res.setHeader('Content-Type',file[2].endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t');
      res.end(media?await readFile(join(directory,file[1],file[2])):file[2].endsWith('.m3u8')?'#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment0.ts\n#EXT-X-ENDLIST\n':Buffer.from([0x47,0,0,0]));return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,requests,controls,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}};
}
