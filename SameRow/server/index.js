const { createApplication } = require('./application');

if (require.main === module) {
  let startupStage = 'configuration';
  (async () => {
    const config = require('./config').configuration();
    startupStage = 'Jellyfin connector configuration';
    const stopConnector = config.localEdition ? require('./jellyfinConnector').startJellyfinConnector() : () => {};
    startupStage = 'Redis connection';
    const store = config.localEdition ? undefined : await require('./store').createStore(config);
    startupStage = 'Firebase, LiveKit and Redis adapter initialization';
    const application = createApplication({ config, store });
    await application.ready;
    application.server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', role: config.serviceRole, media: config.mediaMode })));
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true; application.drain(); stopConnector();
      const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
      await application.close(); clearTimeout(deadline);
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  })().catch(error => {
    const details = startupStage === 'configuration' ? ` ${error.message}` : '';
    console.error(`Startup failed during ${startupStage}.${details}`);
    process.exit(1);
  });
} else {
  module.exports = { ...createApplication(), createApplication };
}
