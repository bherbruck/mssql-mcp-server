#!/usr/bin/env node
// Build the Cowork .plugin bundle.
//
//   1. esbuild --bundle src/index.ts → plugin/server.js (single self-contained file)
//   2. Stage plugin/ + server.js + bundled config.example.yaml in a temp dir
//   3. Zip into dist/plugin/mssql-mcp-server.plugin
//
// Run with: npm run build:plugin

import { build } from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, 'dist', 'plugin-stage');
const out = join(root, 'dist', 'plugin');

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'));
  const version = pkg.version;
  console.log(`Building mssql-mcp-server plugin v${version}…`);

  // Clean staging and output dirs
  await rm(stage, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(out, { recursive: true });

  // 1. Bundle our src with esbuild. Node deps are kept external — esbuild
  // chokes on some transitive deps under mssql (lodash.includes, safer-buffer,
  // ecdsa-sig-formatter) and bundling adds no value when the .plugin zip can
  // ship node_modules alongside server.js.
  await build({
    entryPoints: [join(root, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: join(stage, 'server.js'),
    packages: 'external',
    // ESM compatibility shims for CommonJS deps
    banner: {
      js: `import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);`,
    },
    legalComments: 'none',
    minify: false,
    sourcemap: false,
  });

  // 2. Stage plugin files (manifest, skills, README, sample config)
  await cp(join(root, 'plugin'), stage, { recursive: true });

  // 2b. Drop a minimal package.json into stage and install prod deps so that
  // server.js can `import 'mssql'` at runtime via Node's resolver.
  const stagePkg = {
    name: 'mssql-mcp-server-plugin',
    version,
    private: true,
    type: 'module',
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
  };
  await writeFile(join(stage, 'package.json'), JSON.stringify(stagePkg, null, 2) + '\n');
  console.log('Installing production deps into plugin stage…');
  const npmResult = spawnSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
    { cwd: stage, stdio: 'inherit' }
  );
  if (npmResult.status !== 0) {
    throw new Error('npm install in plugin stage failed');
  }

  // Sync version into plugin.json (in case release-please missed it)
  const manifestPath = join(stage, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  manifest.version = version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // 3. Zip into .plugin (pure-JS so the build works without a system `zip`)
  const pluginFile = join(out, 'mssql-mcp-server.plugin');
  const zip = new AdmZip();
  zip.addLocalFolder(stage);
  zip.writeZip(pluginFile);

  // Sanity check the bundle exists
  if (!existsSync(pluginFile)) {
    throw new Error(`Expected ${pluginFile} not found`);
  }

  console.log(`\n✓ Plugin bundle: ${pluginFile}`);
  console.log(`  Version: ${version}`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
