#!/usr/bin/env node
// Build the Claude Desktop .mcpb bundle.
//
// Layout inside the zip:
//   manifest.json         user-facing config schema + entry point spec
//   server/index.js       our compiled MCP server (with siblings from dist/)
//   server/node_modules/  production dependencies
//
// Claude Desktop reads manifest.json, prompts the user for the user_config
// fields, then launches `node server/index.js` with those values forwarded
// as MSSQL_* env vars. No global node install required — Desktop ships its
// own runtime.

import { mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, 'dist', 'mcpb-stage');
const out = join(root, 'dist', 'mcpb');

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'));
  const version = pkg.version;
  console.log(`Building mssql-mcp-server.mcpb v${version}…`);

  await rm(stage, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(out, { recursive: true });

  const distDir = join(root, 'dist');
  if (!existsSync(join(distDir, 'index.js'))) {
    throw new Error('dist/index.js missing — run `npm run build` first.');
  }

  // Copy compiled TS output into server/, skipping our own build subdirs.
  const serverDir = join(stage, 'server');
  await mkdir(serverDir, { recursive: true });
  const skip = new Set(['mcpb', 'mcpb-stage', 'plugin', 'plugin-stage']);
  for (const entry of await readdir(distDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    await cp(join(distDir, entry.name), join(serverDir, entry.name), { recursive: true });
  }

  // Minimal package.json so server/index.js can resolve mssql at runtime.
  await writeFile(
    join(serverDir, 'package.json'),
    JSON.stringify(
      {
        name: 'mssql-mcp-server-bundled',
        version,
        private: true,
        type: 'module',
        dependencies: pkg.dependencies,
        optionalDependencies: pkg.optionalDependencies,
      },
      null,
      2,
    ) + '\n',
  );

  console.log('Installing production deps into mcpb stage…');
  const npmResult = spawnSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
    { cwd: serverDir, stdio: 'inherit' },
  );
  if (npmResult.status !== 0) {
    throw new Error('npm install in mcpb stage failed');
  }

  // Manifest with version synced (release-please also patches the source file).
  const manifest = JSON.parse(await readFile(join(root, 'mcpb', 'manifest.json'), 'utf-8'));
  manifest.version = version;
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const mcpbFile = join(out, 'mssql-mcp-server.mcpb');
  const zip = new AdmZip();
  zip.addLocalFolder(stage);
  zip.writeZip(mcpbFile);

  if (!existsSync(mcpbFile)) {
    throw new Error(`Expected ${mcpbFile} not found`);
  }

  console.log(`\n✓ MCPB bundle: ${mcpbFile}`);
  console.log(`  Version: ${version}`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
