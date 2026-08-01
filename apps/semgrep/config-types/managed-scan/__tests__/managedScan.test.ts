import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractManagedScanSpecs, managedScanBody, managedScanSpecFromFields } from '../_shared'
import { managedScanFromProject } from '../../../lib/semgrepApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Semgrep REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared / lib helpers — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.projectName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { projectName: 'my-org/my-repo', fullScanEnabled: true, diffScanEnabled: false }

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed managed-scan item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing project name', async () => {
  const res = await validate(ctxOf([{ ...good, projectName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROJECT_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a duplicate project name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, projectName: 'My-Org/My-Repo' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_PROJECT'))
})

test('validate warns when both scan modes are off', async () => {
  const res = await validate(ctxOf([{ projectName: 'org/repo', fullScanEnabled: false, diffScanEnabled: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MANAGED_SCAN_ALL_OFF'))
})

// --- _shared helpers ----------------------------------------------------------

test('managedScanSpecFromFields trims name and reads booleans (default off)', () => {
  const spec = managedScanSpecFromFields({ projectName: '  org/repo  ', fullScanEnabled: 'true' })
  assert.equal(spec.projectName, 'org/repo')
  assert.equal(spec.fullScanEnabled, true)
  assert.equal(spec.diffScanEnabled, false)
})

test('managedScanBody maps the spec onto the PATCH body shape', () => {
  const body = managedScanBody({ projectName: 'org/repo', fullScanEnabled: true, diffScanEnabled: true })
  assert.deepEqual(body, { full_scan: { enabled: true }, diff_scan: { enabled: true } })
})

test('extractManagedScanSpecs reads every item', () => {
  const specs = extractManagedScanSpecs(ctxOf([good, { projectName: 'a/b' }]).canvas)
  assert.equal(specs.length, 2)
  assert.equal(specs[1].projectName, 'a/b')
})

// --- lib helper ---------------------------------------------------------------

test('managedScanFromProject reads flags off a live project (absent = off)', () => {
  assert.deepEqual(managedScanFromProject({ managed_scan_config: { full_scan: { enabled: true } } }), {
    fullScan: true,
    diffScan: false,
  })
  assert.deepEqual(managedScanFromProject(null), { fullScan: false, diffScan: false })
  assert.deepEqual(managedScanFromProject({}), { fullScan: false, diffScan: false })
})
