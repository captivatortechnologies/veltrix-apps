// Extract a normalized dataflow model from an app's manifest.yaml.
//
// The manifest is fully self-describing: pipeline.configurationTypes[] declares
// each config type's `group` (vendor API family) and `handlers` (deploy=write,
// driftDetect=read, rollback, getStatus, healthCheck), plus targets.* seams.
// Everything the dataflow view needs comes from here — no per-file guessing.

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const CODE_FILE = /\.(ts|mjs|js)$/
const CONNECTION_GROUPS = new Set(['settings', 'Settings', 'Connection', 'Connections'])

function loadManifest(appDir) {
  const manifestPath = path.join(appDir, 'manifest.yaml')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.yaml not found in ${appDir}`)
  }
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`manifest.yaml in ${appDir} did not parse to an object`)
  }
  return manifest
}

function libAdapters(appDir) {
  const libDir = path.join(appDir, 'lib')
  if (!fs.existsSync(libDir)) return []
  return fs
    .readdirSync(libDir)
    .filter((f) => CODE_FILE.test(f) && !/\.test\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => f.replace(CODE_FILE, ''))
    .sort()
}

function toType(ct) {
  const h = ct.handlers ?? {}
  const t = ct.targets ?? {}
  return {
    id: ct.id,
    name: ct.name ?? ct.id,
    group: ct.group ?? 'Ungrouped',
    description: (ct.description ?? '').trim(),
    caps: {
      validate: !!h.validate,
      deploy: !!h.deploy, // Platform -> vendor (write)
      drift: !!h.driftDetect, // vendor -> Platform (read)
      rollback: !!h.rollback,
      status: !!h.getStatus,
      health: !!h.healthCheck,
    },
    requiresCredential: t.requiresCredential ?? false,
    requiresConnectivity: t.requiresConnectivity ?? false,
    componentTypes: t.componentTypes ?? [],
  }
}

function groupIntoFamilies(types) {
  const byGroup = new Map()
  for (const t of types) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, [])
    byGroup.get(t.group).push(t)
  }
  return [...byGroup.entries()]
    .map(([name, ts]) => ({
      name,
      isConnection: CONNECTION_GROUPS.has(name),
      types: ts.sort((a, b) => a.name.localeCompare(b.name)),
      deployable: ts.filter((t) => t.caps.deploy).length,
      driftable: ts.filter((t) => t.caps.drift).length,
    }))
    // Vendor families first (by size, desc); connection/settings groups last.
    .sort((a, b) => Number(a.isConnection) - Number(b.isConnection) || b.types.length - a.types.length)
}

export function extractApp(appDir) {
  const manifest = loadManifest(appDir)
  const rawTypes = manifest.pipeline?.configurationTypes ?? []
  const types = rawTypes.map(toType)
  const families = groupIntoFamilies(types)
  const vendorTypes = types.filter((t) => !CONNECTION_GROUPS.has(t.group))

  const requiresCredential = types.some((t) => t.requiresCredential)
  const requiresConnectivity = types.some((t) => t.requiresConnectivity)

  return {
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    vendor: manifest.vendor ?? '',
    version: manifest.version ?? '',
    category: manifest.category ?? '',
    description: (manifest.description ?? '').trim(),
    icon: manifest.icon ?? '',
    homepage: manifest.homepage ?? '',
    primaryColor: manifest.branding?.primaryColor ?? '#2563eb',
    hasConnections: !!manifest.connectivity || !!manifest.settings,
    requiresCredential,
    requiresConnectivity,
    adapters: libAdapters(appDir),
    families,
    counts: {
      types: types.length,
      vendorTypes: vendorTypes.length,
      families: families.filter((f) => !f.isConnection).length,
      deployable: types.filter((t) => t.caps.deploy).length,
      driftable: types.filter((t) => t.caps.drift).length,
      rollbackable: types.filter((t) => t.caps.rollback).length,
    },
  }
}

export function listAppDirs(appsRoot) {
  return fs
    .readdirSync(appsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => path.join(appsRoot, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.yaml')))
    .sort()
}
