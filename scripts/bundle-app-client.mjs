#!/usr/bin/env node
// ============================================================================
// Bundle a staged app's client entry for release packaging.
//
// Used by .github/workflows/release-apps.yml after staging an app: reads the
// staged manifest and, when a client entry is declared, emits the hermetic
// browser bundle at client/dist/index.mjs (see cli/src/lib/client-bundler.mjs
// for the host-runtime shim model). Safe no-op for apps without a client.
//
// Usage: node scripts/bundle-app-client.mjs <staged-app-dir>
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import yaml from 'js-yaml'
import { bundleAppClient } from '../cli/src/lib/client-bundler.mjs'

const appRoot = process.argv[2]
if (!appRoot || !fs.existsSync(path.join(appRoot, 'manifest.yaml'))) {
  console.error('Usage: node scripts/bundle-app-client.mjs <staged-app-dir> (must contain manifest.yaml)')
  process.exit(1)
}

const manifest = yaml.load(fs.readFileSync(path.join(appRoot, 'manifest.yaml'), 'utf8'))
if (!manifest?.client?.entry) {
  console.log(`[bundle-app-client] ${manifest?.id ?? appRoot}: no client entry — skipping`)
  process.exit(0)
}

const outFile = await bundleAppClient({ appRoot, entry: manifest.client.entry })
if (outFile) {
  const sizeKb = Math.round(fs.statSync(outFile).size / 1024)
  console.log(`[bundle-app-client] ${manifest.id}: bundled ${manifest.client.entry} → ${path.relative(appRoot, outFile)} (${sizeKb} KB)`)
} else {
  console.error(`[bundle-app-client] ${manifest.id}: client.entry "${manifest.client.entry}" did not resolve to a file`)
  process.exit(1)
}
