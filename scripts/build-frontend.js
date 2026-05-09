import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['public/js/main.js'],
  bundle: true,
  minify: true,
  sourcemap: true,
  outfile: 'public/js/bundle.min.js',
  format: 'esm',
  target: ['es2022'],
  splitting: false,
});

console.log('Frontend bundle built: public/js/bundle.min.js');
