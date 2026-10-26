const { loadConfig } = require('./config/env');
const { createApp } = require('./app');

try {
  const config = loadConfig();
  createApp(config).listen(config.port, config.host, () => {
    process.stdout.write(`ApCiDa AI server listening at http://${config.host}:${config.port}\n`);
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
