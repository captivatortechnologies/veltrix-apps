import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { packageApp } from '../src/lib/packager.mjs'

test('runtime archives exclude standalone provisioning tools and retain application assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veltrix-package-test-'))
  try {
    const appDir = path.join(root, 'fixture-app')
    const manifest = { id: 'fixture-app', version: '1.0.0' }
    const files = {
      'manifest.yaml': 'id: fixture-app\nversion: 1.0.0\n',
      'server/index.ts': 'export default async function register() {}',
      'server/infra/metadata.json': '{"runtime":true}',
      'infra/bringup/orchestrator.ts': 'import { spawn } from "node:child_process"; spawn("tofu");',
      'infra/bringup/health.mjs': 'process.exit(0)',
      'config-types/configs/canvas.yaml': 'id: configs',
      'assets/logo.svg': '<svg />',
      '__tests__/index.test.ts': 'test("fixture", () => {})',
    }
    for (const [rel, contents] of Object.entries(files)) {
      const file = path.join(appDir, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, contents)
    }
    const info = await packageApp(appDir, path.join(root, 'output'), manifest)
    const entries = new AdmZip(info.zipPath).getEntries().map((entry) => entry.entryName)
    assert.equal(entries.some((entry) => entry.startsWith('infra/')), false)
    assert.equal(entries.some((entry) => entry.startsWith('__tests__/')), false)
    for (const required of ['manifest.yaml', 'server/index.js', 'server/infra/metadata.json', 'config-types/configs/canvas.yaml', 'assets/logo.svg']) {
      assert.ok(entries.includes(required), `Missing runtime file: ${required}`)
    }
    assert.ok(fs.existsSync(path.join(appDir, 'infra/bringup/health.mjs')))
    const repeated = await packageApp(appDir, path.join(root, 'repeat'), manifest)
    assert.equal(repeated.sha256, info.sha256)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
