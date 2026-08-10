#!/usr/bin/env node
/**
 * Generates templates/layouts/base.njk from renderShell() in src/lib/shell.mjs.
 *
 * Runs ahead of Eleventy in `npm run build`. The output is committed so a fresh
 * clone can run `vitest` without building first — test/shell.test.ts reads the
 * committed file and fails if it has drifted from the generator.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderLayoutTemplate } from '../src/lib/shell.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(repoRoot, 'templates/layouts/base.njk');

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, renderLayoutTemplate(), 'utf8');

console.log(`[gen-layout] wrote ${outputPath}`);
