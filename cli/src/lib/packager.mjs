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

const EXCLUDED_DIRS = new Set(['node_modules', '__tests__', '.git', '__pycache__'])
const EXCLUDED_FILES = ['.DS_Store']

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

    fs.mkdirSync(outDir, { recursive: true })
    const zipPath = path.join(outDir, `${manifest.id}.zip`)
    const zip = new AdmZip()
    zip.addLocalFolder(staging)
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
