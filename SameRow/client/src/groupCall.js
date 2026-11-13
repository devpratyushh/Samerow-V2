import { maintainCall } from './callRecovery';

// One uplink per published track. LiveKit supplies congestion control,
// simulcast, TURN fallback and selective subscriptions for group rooms.
export async function connectGroupCall(options) {
  return maintainCall({ ...options, open: recovery => openGroupCall({ ...options, ...recovery }) });
}

async function openGroupCall({ socket, roomId, stream, onPeers, onError, signal, onDisconnected }) {
  const { Room, RoomEvent, Track } = await import('livekit-client');
  if (signal.aborted) return null;
  const credentials = await new Promise((resolve, reject) => socket.timeout(10000).emit('media-token', roomId, (error, reply) => error || reply?.error ? reject(new Error(reply?.error || 'Could not connect the call.')) : resolve(reply)));
  if (signal.aborted) return null;
  if (credentials?.mode !== 'livekit') throw new Error('The room media configuration changed. Rejoin the room.');
  const room = new Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true, stopLocalTrackOnUnpublish: false,
    publishDefaults: { simulcast: true, videoEncoding: { maxBitrate: 1200000, maxFramerate: 24 } } });
  // Capture belongs to App/Room, so a transport reconnect must not stop it.
  const disconnect = () => { room.disconnect(false).catch(() => {}); };
  signal.addEventListener('abort', disconnect, { once: true });
  const refresh = () => {
    if (signal.aborted) return;
    const peers = [];
    for (const participant of room.remoteParticipants.values()) {
      const camera = [], screen = [], cameraTracks = [], screenTracks = [];
      let muted = true, videoOff = true;
      for (const publication of participant.trackPublications.values()) {
        const source = publication.source;
        if (source === Track.Source.Microphone) muted = publication.isMuted;
        if (source === Track.Source.Camera) videoOff = publication.isMuted || !publication.isSubscribed;
        if (!publication.track) continue;
        const target = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio].includes(source) ? screen : camera;
        target.push(publication.track.mediaStreamTrack);
        (target === screen ? screenTracks : cameraTracks).push(publication.track);
      }
      peers.push({ peerID: participant.identity, userName: participant.name || 'Guest', sfu: true, muted, videoOff, stream: new MediaStream(camera), sfuTracks: cameraTracks, isScreenShare: false });
      if (screen.length) peers.push({ peerID: participant.identity, userName: participant.name || 'Guest', sfu: true, stream: new MediaStream(screen), sfuTracks: screenTracks, isScreenShare: true, screenOwner: participant.identity });
    }
    onPeers(peers);
  };
  for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.Reconnected]) room.on(event, refresh);
  room.on(RoomEvent.MediaDevicesError, () => onError('The call lost access to your camera or microphone.'));
  room.on(RoomEvent.Disconnected, () => { if (!signal.aborted) onDisconnected(); });
  let trackQueue = Promise.resolve();
  const syncTracks = () => {
    trackQueue = trackQueue.catch(() => {}).then(async () => {
      if (signal.aborted) return;
      for (const kind of ['audio', 'video']) {
        const source = kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera;
        const track = stream.getTracks().find(value => value.kind === kind && value.readyState === 'live');
        const published = room.localParticipant.getTrackPublication(source);
        if (published?.track?.mediaStreamTrack === track) continue;
        if (published?.track) await room.localParticipant.unpublishTrack(published.track, false);
        if (track) await room.localParticipant.publishTrack(track, { source, name: source, stopMicTrackOnMute: false });
      }
    });
    return trackQueue;
  };
  try {
    await room.connect(credentials.url, credentials.token, { autoSubscribe: true });
    if (signal.aborted) { disconnect(); return null; }
    await syncTracks(); refresh();
  } catch (error) { disconnect(); signal.removeEventListener('abort', disconnect); throw error; }
  return {
    async getStats() {
      const reports = [];
      for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
        for (const publication of participant.trackPublications.values()) {
          if (!publication.track) continue;
          const report = await publication.track.getRTCStatsReport().catch(() => null);
          reports.push({ key: participant.identity, name: `${participant === room.localParticipant ? 'You → SFU' : participant.name || 'Guest'} · ${publication.source}`, report });
        }
      }
      return reports;
    },
    syncTracks,
    async setMuted(kind, muted) {
      if (signal.aborted) return;
      const publication = room.localParticipant.getTrackPublication(kind === 'audio' ? Track.Source.Microphone : Track.Source.Camera);
      if (publication?.track) await (muted ? publication.track.mute() : publication.track.unmute());
    },
    async publishScreen(screenStream) {
      if (signal.aborted) return;
      for (const track of screenStream.getTracks()) await room.localParticipant.publishTrack(track, { source: track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio, name: `screen-${track.kind}`, simulcast: track.kind === 'video' });
    },
    async stopScreen() {
      for (const publication of room.localParticipant.trackPublications.values()) {
        if ([Track.Source.ScreenShare, Track.Source.ScreenShareAudio].includes(publication.source) && publication.track) await room.localParticipant.unpublishTrack(publication.track, false);
      }
    },
    close() { signal.removeEventListener('abort', disconnect); disconnect(); },
  };
}
