import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractSoftwareAppSpecs,
  buildSoftwareAppSettings,
  buildSoftwareAppBody,
  findSoftwareAppByName,
  priorFieldsOf,
  type JumpCloudSoftwareApp,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.displayName ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { displayName: '7-Zip', appCatalogInstallableObjectId: 'cat-123', desiredState: 'Install', autoUpdate: true }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing displayName', async () => {
  const res = await validate(ctxOf([{ ...good, displayName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing app catalog id', async () => {
  const res = await validate(ctxOf([{ ...good, appCatalogInstallableObjectId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CATALOG_ID'))
})

test('validate rejects an invalid desiredState', async () => {
  const res = await validate(ctxOf([{ ...good, desiredState: 'Purge' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATE'))
})

test('validate warns when desiredState is Uninstall', async () => {
  const res = await validate(ctxOf([{ ...good, desiredState: 'Uninstall' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'WILL_UNINSTALL'))
})

test('validate errors on a duplicate displayName', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('extractSoftwareAppSpecs trims fields and defaults desiredState to Install', () => {
  const [spec] = extractSoftwareAppSpecs(canvasOf([{ displayName: ' 7-Zip ', appCatalogInstallableObjectId: ' cat-1 ' }]))
  assert.equal(spec.displayName, '7-Zip')
  assert.equal(spec.appCatalogInstallableObjectId, 'cat-1')
  assert.equal(spec.desiredState, 'Install')
  assert.equal(spec.itemId, 'i0')
})

test('buildSoftwareAppSettings omits displayVersion when unset', () => {
  const settings = buildSoftwareAppSettings({
    displayName: 'A', appCatalogInstallableObjectId: 'c1', displayVersion: '', desiredState: 'Install', autoUpdate: true, allowUpdateDelay: false,
  })
  assert.equal('displayVersion' in settings, false)
  assert.equal(settings.appCatalogInstallableObjectId, 'c1')
})

test('buildSoftwareAppBody wraps exactly one settings entry', () => {
  const body = buildSoftwareAppBody({
    displayName: 'A', appCatalogInstallableObjectId: 'c1', displayVersion: 'v2', desiredState: 'Install', autoUpdate: true, allowUpdateDelay: false,
  })
  assert.equal(body.displayName, 'A')
  assert.equal((body.settings as unknown[]).length, 1)
})

test('findSoftwareAppByName matches case-insensitively', () => {
  const apps: JumpCloudSoftwareApp[] = [{ id: 'a', displayName: '7-Zip' }]
  assert.equal(findSoftwareAppByName(apps, '7-zip')?.id, 'a')
  assert.equal(findSoftwareAppByName(apps, 'MISSING'), null)
})

test('priorFieldsOf captures displayName and the full settings array', () => {
  const prior = priorFieldsOf({ id: 'a', displayName: 'A', settings: [{ appCatalogInstallableObjectId: 'c1' }] })
  assert.equal(prior.displayName, 'A')
  assert.deepEqual(prior.settings, [{ appCatalogInstallableObjectId: 'c1' }])
})
