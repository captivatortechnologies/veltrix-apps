#!/usr/bin/env node
// =============================================================================
// Run the apps' __tests__ for real.
//
// App tests are TypeScript and each app is bundled independently, so there is no
// installed runner that can execute them directly — which meant they only ever
// got typechecked. A test that compiles but never runs asserts nothing, so this
// bundles each test file with esbuild (the same bundler that packages a handler
// for the platform) and hands the result to node:test.
//
//   node scripts/test-apps.mjs             # every app
//   node scripts/test-apps.mjs splunk-cloud
// =============================================================================

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { glob } from 'node:fs/promises'

const only = process.argv.slice(2)

const patterns = [
  'apps/*/config-types/*/__tests__/*.test.ts',
  'apps/*/lib/__tests__/*.test.ts',
  'apps/*/infra/**/__tests__/*.test.ts',
]
const files = []
for (const pattern of patterns) {
  for await (const file of glob(pattern)) files.push(file)
}

const selected = files
  .filter((f) => only.length === 0 || only.some((app) => f.includes(`apps${sep}${app}${sep}`)))
  .sort()

if (selected.length === 0) {
  console.error(only.length ? `No test files for: ${only.join(', ')}` : 'No test files found')
  process.exit(1)
}

const outDir = await mkdtemp(join(tmpdir(), 'veltrix-app-tests-'))

const built = []

try {
  for (const file of selected) {
    // Mirror the source layout in the temp dir so a failure reports a path the
    // reader can map straight back to the repo.
    const outfile = join(outDir, relative('.', file).replace(/\.ts$/, '.mjs'))
    built.push(outfile)
    await mkdir(join(outfile, '..'), { recursive: true })
    await build({
      entryPoints: [file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      logLevel: 'error',
      // Node's own modules stay external; everything else (handlers, libs, the
      // SDK) is bundled exactly as the platform bundles a handler.
      external: ['node:*'],
      // The tests are Jest-shaped but no Jest is installed; supply the globals.
      inject: ['scripts/test-globals.mjs'],
    })
  }

  console.log(`Running ${selected.length} app test file(s)\n`)
  const child = spawn(process.execPath, ['--test', ...built], { stdio: 'inherit' })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  process.exitCode = code ?? 1
} finally {
  await rm(outDir, { recursive: true, force: true })
}
