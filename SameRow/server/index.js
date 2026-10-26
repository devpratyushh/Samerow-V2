const { createApplication } = require('./application');

if (require.main === module) {
  (async () => {
    const config = require('./config').configuration();
    const store = await require('./store').createStore(config);
    const application = createApplication({ config, store });
    await application.ready;
    application.server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', role: config.serviceRole, media: config.mediaMode })));
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true; application.drain();
      const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
      await application.close(); clearTimeout(deadline);
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  })().catch(() => { console.error('Startup failed. Check the required production configuration and service connections.'); process.exit(1); });
} else {
  module.exports = { ...createApplication(), createApplication };
}
