#!/usr/bin/env node
// ============================================================================
// CI wrapper around the canonical validator, which lives in the CLI package
// (cli/src/lib/validator.mjs) so `veltrix validate` and CI enforce identical
// rules. js-yaml resolves from the repo root install in CI.
//
// Usage:  node scripts/validate-app.mjs apps/<app-id> [apps/<other-app> ...]
// Exit codes: 0 = valid, 1 = validation errors, 2 = usage error
// ============================================================================

import path from 'node:path'
import { validateApp, checkClientBundle, printResults } from '../cli/src/lib/validator.mjs'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('Usage: node scripts/validate-app.mjs apps/<app-id> [apps/<other-app> ...]')
  process.exit(2)
}

let failed = false
for (const target of targets) {
  const result = validateApp(target)
  const bundle = await checkClientBundle(target, result.manifest)
  result.errors.push(...bundle.errors)
  result.warnings.push(...bundle.warnings)
  if (printResults(path.basename(path.resolve(target)), result)) failed = true
}
process.exit(failed ? 1 : 0)
