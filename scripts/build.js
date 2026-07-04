const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/plugin.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'com.nexus.streamdeck.sdPlugin/bin/plugin.js',
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  esbuild.context(config).then(ctx => ctx.watch());
} else {
  esbuild.build(config);
}
