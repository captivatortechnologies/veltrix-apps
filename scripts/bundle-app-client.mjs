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
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { bundleAppClient } from '../cli/src/lib/client-bundler.mjs'

const appRoot = process.argv[2]
if (!appRoot || !fs.existsSync(path.join(appRoot, 'manifest.yaml'))) {
  console.error('Usage: node scripts/bundle-app-client.mjs <staged-app-dir> (must contain manifest.yaml)')
  process.exit(1)
}

// The host-runtime shim covers react + the sdk/hooks/client/ui subpaths, but an
// app client may also import BUNDLED sdk component surfaces (e.g.
// @veltrixsecops/app-sdk/byol, /connections) that are compiled INTO the bundle
// rather than read from the host runtime. Those need a real node_modules to
// resolve from: the app is staged to a temp dir without one, so point esbuild
// at the repo's node_modules (where the built SDK is linked) plus the app's own.
// Missing directories are ignored by esbuild, so this stays safe for pure-shim
// apps that resolve nothing.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const nodePaths = [
  process.env.VELTRIX_SDK_NODE_PATHS,
  path.join(path.resolve(appRoot), 'node_modules'),
  path.join(repoRoot, 'node_modules'),
].filter(Boolean)

const manifest = yaml.load(fs.readFileSync(path.join(appRoot, 'manifest.yaml'), 'utf8'))
if (!manifest?.client?.entry) {
  console.log(`[bundle-app-client] ${manifest?.id ?? appRoot}: no client entry — skipping`)
  process.exit(0)
}

const outFile = await bundleAppClient({ appRoot, entry: manifest.client.entry, nodePaths })
if (outFile) {
  const sizeKb = Math.round(fs.statSync(outFile).size / 1024)
  console.log(`[bundle-app-client] ${manifest.id}: bundled ${manifest.client.entry} → ${path.relative(appRoot, outFile)} (${sizeKb} KB)`)
} else {
  console.error(`[bundle-app-client] ${manifest.id}: client.entry "${manifest.client.entry}" did not resolve to a file`)
  process.exit(1)
}
