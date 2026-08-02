import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractServerGroupSpecs,
  buildServerGroupBody,
  priorServerGroupFieldsOf,
  findServerGroupByName,
  serverGroupKey,
  triStateToBool,
  boolToTriState,
  type ServerGroupSpec,
  type AutomoxServerGroup,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

function specOf(fields: Record<string, unknown>): ServerGroupSpec {
  return extractServerGroupSpecs(canvasOf([fields]))[0]
}

const good = {
  name: 'Workstations',
  parent_server_group_id: 23500,
  refresh_interval: 1440,
  ui_color: '#0072CE',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed Server Group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate requires a parent_server_group_id', async () => {
  const res = await validate(ctxOf([{ ...good, parent_server_group_id: undefined }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.includes('parent_server_group_id')))
})

test('validate rejects a refresh_interval outside 360-1440', async () => {
  const tooLow = await validate(ctxOf([{ ...good, refresh_interval: 100 }]))
  assert.equal(tooLow.valid, false)
  assert.ok(tooLow.errors.some((e) => e.code === 'INVALID_REFRESH_INTERVAL'))

  const tooHigh = await validate(ctxOf([{ ...good, refresh_interval: 2000 }]))
  assert.equal(tooHigh.valid, false)
  assert.ok(tooHigh.errors.some((e) => e.code === 'INVALID_REFRESH_INTERVAL'))
})

test('validate rejects a malformed ui_color', async () => {
  const res = await validate(ctxOf([{ ...good, ui_color: 'blue' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_UI_COLOR'))
})

test('validate requires wsus_server when enable_wsus is "enable"', async () => {
  const res = await validate(ctxOf([{ ...good, enable_wsus: 'enable', wsus_server: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.includes('wsus_server')))
})

test('validate accepts enable_wsus="enable" with a wsus_server supplied', async () => {
  const res = await validate(ctxOf([{ ...good, enable_wsus: 'enable', wsus_server: 'https://wsus.internal:8530' }]))
  assert.equal(res.valid, true)
})

test('validate rejects non-numeric linked policy ids', async () => {
  const res = await validate(ctxOf([{ ...good, policies: ['abc'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_POLICY_IDS'))
})

test('validate rejects a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'workstations' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ------------------------------------------------------------

test('extractServerGroupSpecs defaults refresh_interval to 1440 and reads tri-state as keep', () => {
  const spec = specOf({ name: 'X', parent_server_group_id: 1 })
  assert.equal(spec.refreshInterval, 1440)
  assert.equal(spec.enableOsAutoUpdate, 'keep')
  assert.equal(spec.enableWsus, 'keep')
})

test('triStateToBool / boolToTriState round-trip', () => {
  assert.equal(triStateToBool('enable'), true)
  assert.equal(triStateToBool('disable'), false)
  assert.equal(triStateToBool('keep'), null)
  assert.equal(boolToTriState(true), 'enable')
  assert.equal(boolToTriState(false), 'disable')
  assert.equal(boolToTriState(null), 'keep')
  assert.equal(boolToTriState(undefined), 'keep')
})

test('buildServerGroupBody maps tri-state selects to nullable booleans and omits blank optionals', () => {
  const body = buildServerGroupBody(specOf(good))
  assert.equal(body.name, 'Workstations')
  assert.equal(body.parent_server_group_id, 23500)
  assert.equal(body.enable_os_auto_update, null)
  assert.equal(body.enable_wsus, null)
  assert.equal(body.ui_color, '#0072CE')
  assert.equal('wsus_server' in body, false)
})

test('buildServerGroupBody includes wsus_server when supplied', () => {
  const body = buildServerGroupBody(specOf({ ...good, enable_wsus: 'enable', wsus_server: 'https://wsus.internal:8530' }))
  assert.equal(body.enable_wsus, true)
  assert.equal(body.wsus_server, 'https://wsus.internal:8530')
})

test('findServerGroupByName matches case-insensitively', () => {
  const groups: AutomoxServerGroup[] = [{ id: 1, name: 'Workstations' }, { id: 2, name: 'Servers' }]
  assert.equal(findServerGroupByName(groups, 'workstations')?.id, 1)
  assert.equal(findServerGroupByName(groups, 'missing'), null)
})

test('serverGroupKey trims and lowercases', () => {
  assert.equal(serverGroupKey('  Workstations  '), 'workstations')
})

test('priorServerGroupFieldsOf captures the managed fields for rollback', () => {
  const prior = priorServerGroupFieldsOf({
    id: 1,
    name: 'Workstations',
    refresh_interval: 720,
    parent_server_group_id: 23500,
    ui_color: '#FFFFFF',
    notes: 'n',
    enable_os_auto_update: true,
    enable_wsus: null,
    policies: [1, 2],
  })
  assert.equal(prior.name, 'Workstations')
  assert.equal(prior.refresh_interval, 720)
  assert.equal(prior.enable_os_auto_update, true)
  assert.equal(prior.enable_wsus, null)
  assert.deepEqual(prior.policies, [1, 2])
})
