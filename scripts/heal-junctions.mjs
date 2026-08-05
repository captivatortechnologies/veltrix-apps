#!/usr/bin/env node
// Heal the per-app `node_modules/@veltrixsecops/app-sdk` link.
//
// Apps import `@veltrixsecops/app-sdk` (e.g. the client `ConnectionsPage` pulls
// `@veltrixsecops/app-sdk/connections`), and `validate-app.mjs`'s client bundle
// check resolves it through a junction in each app's own `node_modules` pointing
// at the repo's built `/sdk`. That link lives under gitignored `node_modules`, so
// a fresh checkout — or an app that never had `npm install` run — is missing it
// and every `validate-app` on that app fails with:
//   Could not resolve "@veltrixsecops/app-sdk/connections"
//
// This script (re)creates that link for every app, idempotently. It only ever
// touches `node_modules/@veltrixsecops/app-sdk`; it does not install other deps.
//
//   node scripts/heal-junctions.mjs            # heal all apps
//   node scripts/heal-junctions.mjs okta-identity ibm-qradar   # heal specific apps

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdkDir = path.join(repoRoot, 'sdk')
const appsDir = path.join(repoRoot, 'apps')
// Windows wants 'junction' for directories (no admin needed); POSIX uses 'dir'.
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

function sdkName() {
  try {
    return JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8')).name
  } catch {
    return null
  }
}

/** Does `linkPath` already resolve to the repo sdk dir? */
function pointsAtSdk(linkPath) {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(sdkDir)
  } catch {
    return false
  }
}

function healApp(app) {
  const scope = path.join(appsDir, app, 'node_modules', '@veltrixsecops')
  const link = path.join(scope, 'app-sdk')

  if (fs.existsSync(link)) {
    if (pointsAtSdk(link)) return 'ok'
    // Wrong/stale target (or a leftover copy) — replace it.
    fs.rmSync(link, { recursive: true, force: true })
  }
  fs.mkdirSync(scope, { recursive: true })
  fs.symlinkSync(sdkDir, link, linkType)
  return 'linked'
}

function main() {
  if (!fs.existsSync(path.join(sdkDir, 'package.json'))) {
    console.error(`No SDK found at ${sdkDir} — build/checkout the sdk package first.`)
    process.exit(1)
  }
  const name = sdkName()
  if (name && name !== '@veltrixsecops/app-sdk') {
    console.error(`sdk/package.json name is "${name}", expected "@veltrixsecops/app-sdk".`)
    process.exit(1)
  }

  const requested = process.argv.slice(2)
  const apps = (requested.length ? requested : fs.readdirSync(appsDir)).filter((a) =>
    fs.existsSync(path.join(appsDir, a, 'manifest.yaml')),
  )

  let linked = 0
  let ok = 0
  const failures = []
  for (const app of apps) {
    try {
      if (healApp(app) === 'linked') {
        linked++
        console.log(`  linked  ${app}`)
      } else {
        ok++
      }
    } catch (err) {
      failures.push(`${app}: ${err.message}`)
    }
  }

  console.log(`\nhealed ${linked} · already ok ${ok} · apps ${apps.length}`)
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
}

main()
