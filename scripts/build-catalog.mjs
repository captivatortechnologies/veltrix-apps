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
import { readChangelogEntry } from '../cli/src/lib/changelog.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// Resolve a manifest branding logo reference to something the marketplace can
// render before the app is installed: an https:// URL is passed through
// verbatim; a repo-relative .svg/.png file is inlined as a self-contained
// data: URL so the published catalog needs no companion asset hosting.
const LOGO_MIME = { '.svg': 'image/svg+xml', '.png': 'image/png' }
function resolveCatalogLogo(appDir, ref) {
  if (typeof ref !== 'string' || !ref.trim()) return undefined
  const trimmed = ref.trim()
  if (/^https:\/\//i.test(trimmed)) return trimmed
  const rel = trimmed.replace(/^\.\//, '')
  if (rel.split(/[\\/]/).includes('..')) return undefined
  const mime = LOGO_MIME[path.extname(rel).toLowerCase()]
  if (!mime) return undefined
  const full = path.join(appDir, rel)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return undefined
  return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`
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
  const appDir = path.join(appsDir, appId)
  const logo = resolveCatalogLogo(appDir, manifest.branding?.logo)
  const logoDark = resolveCatalogLogo(appDir, manifest.branding?.logoDark)
  const zipPath = path.join(distDir, `${appId}.zip`)
  const prior = previousById.get(appId)

  let release
  if (fs.existsSync(zipPath)) {
    const buffer = fs.readFileSync(zipPath)
    const publishedAt = new Date().toISOString()
    // Release notes for this exact version come from the app's CHANGELOG.md;
    // the platform's upgrade banner renders them. Prefer the CHANGELOG's dated
    // heading for `releasedAt`, falling back to the publish timestamp.
    const changelog = readChangelogEntry(path.join(appDir, 'CHANGELOG.md'), manifest.version)
    release = {
      version: manifest.version,
      downloadUrl: `https://github.com/${repo}/releases/download/${appId}-v${manifest.version}/${appId}.zip`,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.byteLength,
      publishedAt,
      ...(changelog?.notes ? { releaseNotes: changelog.notes } : {}),
      releasedAt: changelog?.date ? `${changelog.date}T00:00:00.000Z` : publishedAt,
    }
  } else if (prior?.downloadUrl) {
    release = {
      version: prior.version,
      downloadUrl: prior.downloadUrl,
      sha256: prior.sha256,
      sizeBytes: prior.sizeBytes,
      publishedAt: prior.publishedAt,
      ...(prior.releaseNotes ? { releaseNotes: prior.releaseNotes } : {}),
      ...(prior.releasedAt ? { releasedAt: prior.releasedAt } : {}),
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
    ...(logo ? { logo } : {}),
    ...(logoDark ? { logoDark } : {}),
    license: manifest.license,
    homepage: manifest.homepage,
    available: true,
    downloadUrl: release.downloadUrl,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    publishedAt: release.publishedAt,
    ...(release.releaseNotes ? { releaseNotes: release.releaseNotes } : {}),
    ...(release.releasedAt ? { releasedAt: release.releasedAt } : {}),
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
