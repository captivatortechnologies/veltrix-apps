// ============================================================================
// App packager — builds a release-identical ZIP locally.
//
// Mirrors the release workflow: stage the app (excluding node_modules and
// tests), transpile server-side TypeScript to CommonJS with esbuild (the
// hosted platform runs compiled code), and zip the staging tree.
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { build } from 'esbuild'
import AdmZip from 'adm-zip'
import { bundleAppClient } from './client-bundler.mjs'

const EXCLUDED_DIRS = new Set(['node_modules', '__tests__', '.git', '__pycache__'])
const EXCLUDED_FILES = ['.DS_Store']
const FIXED_ZIP_DATE = new Date('2000-01-01T00:00:00.000Z')

function collectFilesSorted(dir, out = []) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFilesSorted(full, out)
    else out.push(full)
  }
  return out
}

function shouldCopy(src) {
  const base = path.basename(src)
  if (EXCLUDED_DIRS.has(base)) return false
  if (EXCLUDED_FILES.includes(base)) return false
  if (/\.test\.[a-z]+$/.test(base)) return false
  return true
}

function collectTsFiles(dir, appRoot, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // client/ ships as source — the platform does not transpile .tsx server-side
      if (path.relative(appRoot, full) === 'client') continue
      collectTsFiles(full, appRoot, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Package an app directory into a ZIP.
 * Returns { zipPath, sha256, sizeBytes, fileCount, appId, version }.
 */
export async function packageApp(appDir, outDir, manifest) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-pkg-'))
  try {
    fs.cpSync(appDir, staging, { recursive: true, filter: shouldCopy })

    const tsFiles = collectTsFiles(staging, staging)
    if (tsFiles.length > 0) {
      await build({
        entryPoints: tsFiles,
        outdir: staging,
        outbase: staging,
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        logLevel: 'warning',
      })
    }

    // Bundle the client entry (if declared) into a hermetic ESM bundle the
    // platform serves to browsers. The app's real node_modules are offered
    // for apps that bundle extra client-side dependencies.
    if (manifest.client?.entry) {
      await bundleAppClient({
        appRoot: staging,
        entry: manifest.client.entry,
        nodePaths: [path.join(appDir, 'node_modules')],
      })
    }

    fs.mkdirSync(outDir, { recursive: true })
    const zipPath = path.join(outDir, `${manifest.id}.zip`)
    const zip = new AdmZip()
    // Deterministic archive: sorted entries + fixed timestamps, so packaging
    // the same source always yields the same sha256 (reproducible releases).
    for (const file of collectFilesSorted(staging)) {
      const rel = path.relative(staging, file).split(path.sep).join('/')
      zip.addFile(rel, fs.readFileSync(file))
    }
    for (const entry of zip.getEntries()) {
      entry.header.time = FIXED_ZIP_DATE
    }
    zip.writeZip(zipPath)

    const buffer = fs.readFileSync(zipPath)
    return {
      zipPath,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.byteLength,
      fileCount: zip.getEntries().length,
      appId: manifest.id,
      version: manifest.version,
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
