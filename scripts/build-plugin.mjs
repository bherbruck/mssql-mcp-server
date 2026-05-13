#!/usr/bin/env node
// Build the Cowork / Claude Code .plugin bundle.
//
// The plugin itself is thin: just `.claude-plugin/plugin.json`, `.mcp.json`,
// skills, README, and LICENSE. The MCP server runs via `npx -y
// github:bherbruck/mssql-mcp-server` (see plugin/.mcp.json), so no node_modules
// or compiled bundle ships inside the plugin.
//
// Run with: npm run build:plugin

import { mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

  await rm(stage, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(out, { recursive: true });

  // Copy plugin/ contents into the stage as-is.
  await cp(join(root, 'plugin'), stage, { recursive: true });

  // Sync version into plugin.json (in case release-please missed it).
  const manifestPath = join(stage, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  manifest.version = version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const pluginFile = join(out, 'mssql-mcp-server.plugin');
  const zip = new AdmZip();
  zip.addLocalFolder(stage);
  zip.writeZip(pluginFile);

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
