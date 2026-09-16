#!/usr/bin/env node
// =============================================================================
// Which pipeline handlers are actually exercised by a test?
//
// Every configuration type in this repository has a __tests__ folder, which is
// not the same as every HANDLER being tested. When this script was written, the
// picture was:
//
//     validate      1170 / 1170   100.0%
//     deploy         179 / 1170    15.3%
//     driftDetect      8 / 1170     0.7%
//     rollback         6 / 1170     0.5%
//     healthCheck      1 / 1170     0.1%
//     getStatus        0 / 1170     0.0%
//
// 19.43% overall — and the untested 80% is precisely the part that acts on a
// customer's infrastructure. `validate` is local logic; deploy, rollback,
// healthCheck and driftDetect reach the vendor and change things.
//
// Testing them needs nothing exotic: 89 of 96 apps reach their vendor through
// global `fetch`, so stubbing `globalThis.fetch` drives a handler end to end
// with no module mocking and no new dependency. The worked example is
// apps/crowdstrike-edr/config-types/cloud-groups/__tests__/deploy.test.ts
//
//   node scripts/handler-coverage.mjs              # whole catalog
//   node scripts/handler-coverage.mjs okta-identity # one app
//   node scripts/handler-coverage.mjs --min 25     # exit 1 below this percentage
//
// The --min flag is the ratchet: raise it as coverage climbs so it cannot slide
// back.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const KINDS = ['validate', 'deploy', 'rollback', 'healthCheck', 'driftDetect', 'getStatus']
/** The handlers that reach the vendor and change things. */
const ACTING = new Set(['deploy', 'rollback', 'healthCheck', 'driftDetect'])

const argv = process.argv.slice(2)
const minIndex = argv.indexOf('--min')
const min = minIndex === -1 ? null : Number(argv[minIndex + 1])
// Skip the flag and its value. `minIndex + 1` is only the flag's value when the
// flag is actually present — without this guard it is index 0, which silently
// swallowed the app name and reported the whole catalog instead.
const minValueIndex = minIndex === -1 ? -1 : minIndex + 1
const only = argv.filter((a, i) => !a.startsWith('--') && i !== minValueIndex)

const APPS = path.resolve('apps')

const apps = fs
  .readdirSync(APPS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => only.length === 0 || only.includes(name))
  .sort()

const covered = Object.fromEntries(KINDS.map((k) => [k, 0]))
const declared = Object.fromEntries(KINDS.map((k) => [k, 0]))
const perApp = []

for (const app of apps) {
  const appDir = path.join(APPS, app)
  let manifest
  try {
    manifest = yaml.load(fs.readFileSync(path.join(appDir, 'manifest.yaml'), 'utf8'))
  } catch {
    continue
  }

  let appDeclared = 0
  let appCovered = 0

  for (const ct of manifest?.pipeline?.configurationTypes ?? []) {
    const handlers = ct?.handlers ?? {}
    const first = String(Object.values(handlers)[0] ?? '')
    const testDir = path.join(appDir, path.dirname(first), '__tests__')

    let testFiles = []
    try {
      testFiles = fs.readdirSync(testDir)
    } catch {
      testFiles = []
    }
    // One test file can cover several handlers, so read them all once.
    const blob = testFiles
      .map((f) => {
        try {
          return fs.readFileSync(path.join(testDir, f), 'utf8')
        } catch {
          return ''
        }
      })
      .join('\n')

    for (const kind of KINDS) {
      if (!(kind in handlers)) continue
      declared[kind]++
      appDeclared++
      // Named by a test file, or imported/called inside one.
      const named = testFiles.some((f) => f.toLowerCase().startsWith(kind.toLowerCase()))
      const referenced = new RegExp(`['"./]${kind}['"]|\\b${kind}\\s*\\(`).test(blob)
      if (named || referenced) {
        covered[kind]++
        appCovered++
      }
    }
  }

  if (appDeclared > 0) perApp.push({ app, declared: appDeclared, covered: appCovered })
}

const totalDeclared = Object.values(declared).reduce((a, b) => a + b, 0)
const totalCovered = Object.values(covered).reduce((a, b) => a + b, 0)
const pct = totalDeclared === 0 ? 0 : (totalCovered / totalDeclared) * 100

console.log('handler kind      tested / declared')
for (const k of KINDS) {
  const p = declared[k] ? ((covered[k] / declared[k]) * 100).toFixed(1) : '—'
  const flag = ACTING.has(k) ? ' *' : '  '
  console.log(
    `  ${k.padEnd(13)}${flag} ${String(covered[k]).padStart(5)} / ${String(declared[k]).padEnd(5)}  ${p}%`,
  )
}
console.log('  * reaches the vendor and changes things')
console.log(`\noverall: ${pct.toFixed(2)}%  (${totalCovered}/${totalDeclared})`)

const weakest = perApp
  .map((r) => ({ ...r, pct: (r.covered / r.declared) * 100 }))
  .sort((a, b) => a.pct - b.pct)
  .filter((r) => r.pct < 100)

if (weakest.length > 0 && only.length !== 1) {
  console.log(`\nweakest apps (${weakest.length} below 100%)`)
  for (const r of weakest.slice(0, 15)) {
    console.log(`  ${r.app.padEnd(28)} ${r.covered}/${r.declared}  ${r.pct.toFixed(1)}%`)
  }
  if (weakest.length > 15) console.log(`  ... and ${weakest.length - 15} more`)
}

if (min !== null && pct < min) {
  console.error(`\n✖ handler coverage ${pct.toFixed(2)}% is below the required ${min}%`)
  process.exit(1)
}
