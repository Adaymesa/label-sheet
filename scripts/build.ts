/**
 * Bundles the app into a single self-contained HTML file.
 *
 * No network requests at runtime: the pdf.js worker is inlined as a string and started
 * from a blob URL, so the page works from a bookmark, a file:// path, or offline.
 */
import { build, type Plugin } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs');

/** Resolves `virtual:pdf-worker` to the pdf.js worker source, as a string. */
const pdfWorkerPlugin: Plugin = {
  name: 'pdf-worker',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^virtual:pdf-worker$/ }, () => ({
      path: workerPath,
      namespace: 'pdf-worker',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'pdf-worker' }, async () => ({
      contents: await readFile(workerPath, 'utf8'),
      loader: 'text',
    }));
  },
};

/**
 * Resolves `virtual:cmaps` to every pdf.js CMap, base64-encoded.
 *
 * Needed so CJK recipient names decode. They are the bulk of the bundle, but a label with
 * a Japanese name is otherwise read as its street line.
 */
const cmapsDir = join(root, 'node_modules', 'pdfjs-dist', 'cmaps');

const cmapsPlugin: Plugin = {
  name: 'cmaps',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^virtual:cmaps$/ }, (args) => ({
      path: args.path,
      namespace: 'cmaps',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'cmaps' }, async () => {
      const { readdir } = await import('node:fs/promises');
      const names = (await readdir(cmapsDir)).filter((f) => f.endsWith('.bcmap'));
      const entries = await Promise.all(
        names.map(async (f) => {
          const data = await readFile(join(cmapsDir, f));
          return `${JSON.stringify(f.replace(/\.bcmap$/, ''))}:"${data.toString('base64')}"`;
        }),
      );
      return {
        contents: `export default {${entries.join(',')}};`,
        loader: 'js',
      };
    });
  },
};

const result = await build({
  entryPoints: [join(root, 'src', 'browser', 'main.ts')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  write: false,
  legalComments: 'none',
  plugins: [pdfWorkerPlugin, cmapsPlugin],
});

const script = result.outputFiles[0]?.text;
if (!script) throw new Error('esbuild produced no output');

const shell = await readFile(join(root, 'src', 'browser', 'index.html'), 'utf8');

// A closing tag inside the bundle would end the script element early.
const safeScript = script.replace(/<\/script/gi, '<\\/script');

const html = `${shell}\n<script type="module">\n${safeScript}\n</script>\n`;

/**
 * The page is one HTML file with no charset declaration, and it has to survive being
 * opened straight off disk. A stray UTF-8 byte gets decoded as latin-1 there, which once
 * silently broke a regex containing "ó" so Paq labels stopped being recognised. Keep the
 * whole output ASCII and write non-ASCII as \\u escapes in the source instead.
 */
const nonAscii = [...html].findIndex((c) => c.codePointAt(0)! > 127);
if (nonAscii >= 0) {
  const around = html.slice(Math.max(0, nonAscii - 60), nonAscii + 60);
  throw new Error(
    `Build output contains a non-ASCII character at index ${nonAscii}. ` +
      `Escape it as \\uXXXX in the source.\n...${around}...`,
  );
}

const outDir = join(root, 'dist');
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, 'label-sheet.html');
await writeFile(outFile, html, 'utf8');

console.log(`${outFile}  ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
