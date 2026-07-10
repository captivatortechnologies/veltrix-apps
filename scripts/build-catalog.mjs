#!/usr/bin/env node
// ============================================================================
// Marketplace catalog builder
//
// Regenerates catalog/catalog.json from every apps/*/manifest.yaml, merged
// with the previous catalog. Apps with a freshly built package in --dist get
// their version/sha256/sizeBytes/publishedAt/downloadUrl refreshed; other
// apps keep their previously published release info. Apps that have never
// been released are skipped (nothing to download yet).
//
// Usage:
//   node scripts/build-catalog.mjs --repo owner/name [--dist dist/apps] [--out catalog/catalog.json]
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import yaml from 'js-yaml'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const repo = arg('repo')
const distDir = arg('dist', 'dist/apps')
const outFile = arg('out', 'catalog/catalog.json')
const appsDir = 'apps'

if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('Usage: node scripts/build-catalog.mjs --repo owner/name [--dist dist/apps] [--out catalog/catalog.json]')
  process.exit(2)
}

// Previous catalog (release info for apps not rebuilt in this run)
let previous = { apps: [] }
if (fs.existsSync(outFile)) {
  try {
    previous = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  } catch {
    console.warn(`Previous catalog at ${outFile} is unreadable — rebuilding from scratch`)
  }
}
const previousById = new Map((previous.apps ?? []).map((a) => [a.appId, a]))

const entries = []
for (const dirent of fs.readdirSync(appsDir, { withFileTypes: true })) {
  if (!dirent.isDirectory() || dirent.name.startsWith('_')) continue
  const appId = dirent.name
  const manifestPath = path.join(appsDir, appId, 'manifest.yaml')
  if (!fs.existsSync(manifestPath)) continue

  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'))
  const zipPath = path.join(distDir, `${appId}.zip`)
  const prior = previousById.get(appId)

  let release
  if (fs.existsSync(zipPath)) {
    const buffer = fs.readFileSync(zipPath)
    release = {
      version: manifest.version,
      downloadUrl: `https://github.com/${repo}/releases/download/${appId}-v${manifest.version}/${appId}.zip`,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.byteLength,
      publishedAt: new Date().toISOString(),
    }
  } else if (prior?.downloadUrl) {
    release = {
      version: prior.version,
      downloadUrl: prior.downloadUrl,
      sha256: prior.sha256,
      sizeBytes: prior.sizeBytes,
      publishedAt: prior.publishedAt,
    }
  } else {
    console.warn(`Skipping ${appId}: no built package and no prior release info`)
    continue
  }

  entries.push({
    appId,
    name: manifest.name,
    version: release.version,
    vendor: manifest.vendor,
    description: String(manifest.description ?? '').trim(),
    category: manifest.category,
    icon: manifest.icon,
    license: manifest.license,
    homepage: manifest.homepage,
    available: true,
    downloadUrl: release.downloadUrl,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    publishedAt: release.publishedAt,
  })
}

entries.sort((a, b) => a.appId.localeCompare(b.appId))

const catalog = {
  schemaVersion: 1,
  repository: `https://github.com/${repo}`,
  generatedAt: new Date().toISOString(),
  apps: entries,
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(catalog, null, 2) + '\n')
console.log(`Wrote ${outFile} with ${entries.length} app(s): ${entries.map((e) => `${e.appId}@${e.version}`).join(', ') || '(none)'}`)
