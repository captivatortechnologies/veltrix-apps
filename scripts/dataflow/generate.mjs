#!/usr/bin/env node
// Generate dataflow views for one or more apps from their manifests.
//
//   node scripts/dataflow/generate.mjs <app-id|dir> [more...]   # specific apps
//   node scripts/dataflow/generate.mjs --all                    # every app under apps/
//
// Writes apps/<id>/DATAFLOW.md (Mermaid, renders on GitHub) for each app.
// Options:
//   --site-dir <dir>   also write standalone <id>.html (+ index.html) into <dir>
//   --body-out <path>  write the artifact body fragment for a single app to <path>
//   --no-md            skip DATAFLOW.md (site only)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractApp, listAppDirs } from './extract.mjs'
import { renderMarkdown } from './render-mermaid.mjs'
import { renderStandalone, renderBody, renderIndex } from './render-site.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const APPS = path.join(REPO, 'apps')

function parseArgs(argv) {
  const opts = { apps: [], all: false, siteDir: null, bodyOut: null, md: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') opts.all = true
    else if (a === '--site-dir') opts.siteDir = argv[++i]
    else if (a === '--body-out') opts.bodyOut = argv[++i]
    else if (a === '--no-md') opts.md = false
    else opts.apps.push(a)
  }
  return opts
}

function resolveAppDir(arg) {
  if (fs.existsSync(path.join(arg, 'manifest.yaml'))) return path.resolve(arg)
  const byId = path.join(APPS, arg)
  if (fs.existsSync(path.join(byId, 'manifest.yaml'))) return byId
  throw new Error(`no app found for "${arg}" (looked for ${arg}/manifest.yaml and apps/${arg}/manifest.yaml)`)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const dirs = opts.all ? listAppDirs(APPS) : opts.apps.map(resolveAppDir)
  if (!dirs.length) {
    console.error('Usage: node scripts/dataflow/generate.mjs <app-id|dir>... | --all [--site-dir <dir>] [--body-out <path>] [--no-md]')
    process.exit(1)
  }

  if (opts.siteDir) fs.mkdirSync(opts.siteDir, { recursive: true })
  const models = []

  for (const dir of dirs) {
    const model = extractApp(dir)
    models.push(model)
    if (opts.md) {
      const mdPath = path.join(dir, 'DATAFLOW.md')
      fs.writeFileSync(mdPath, renderMarkdown(model))
      console.log(`  md   ${path.relative(REPO, mdPath)}  (${model.counts.vendorTypes} types · ${model.counts.families} families)`)
    }
    if (opts.siteDir) {
      const htmlPath = path.join(opts.siteDir, `${model.id}.html`)
      fs.writeFileSync(htmlPath, renderStandalone(model))
      console.log(`  site ${path.relative(REPO, htmlPath)}`)
    }
    if (opts.bodyOut && dirs.length === 1) {
      fs.writeFileSync(opts.bodyOut, renderBody(model))
      console.log(`  body ${opts.bodyOut}`)
    }
  }

  if (opts.siteDir && models.length > 1) {
    const idxPath = path.join(opts.siteDir, 'index.html')
    fs.writeFileSync(idxPath, renderIndex(models))
    console.log(`  idx  ${path.relative(REPO, idxPath)}`)
  }
  console.log(`Done — ${models.length} app(s).`)
}

main()
