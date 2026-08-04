import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractIpListSpecs,
  toIpList,
  isPlausibleIpOrCidr,
  buildIpListBody,
  findIpListByName,
  priorFieldsOf,
  type JumpCloudIpList,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/health/drift handlers talk to the JumpCloud API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (network-free).
 */
function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { name: 'Corp Offices', description: 'Office egress ranges', ips: ['203.0.113.0/24', '198.51.100.7'] }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an empty ips list', async () => {
  const res = await validate(ctxOf([{ ...good, ips: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IPS'))
})

test('validate warns on a suspect IP entry', async () => {
  const res = await validate(ctxOf([{ ...good, ips: ['not-an-ip'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_IP'))
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('toIpList splits strings, trims and de-dupes case-insensitively', () => {
  assert.deepEqual(toIpList('10.0.0.1, 10.0.0.2\n10.0.0.1'), ['10.0.0.1', '10.0.0.2'])
  assert.deepEqual(toIpList(['10.0.0.1', ' 10.0.0.2 ']), ['10.0.0.1', '10.0.0.2'])
})

test('isPlausibleIpOrCidr accepts IPv4/CIDR and rejects obvious junk', () => {
  assert.equal(isPlausibleIpOrCidr('203.0.113.0/24'), true)
  assert.equal(isPlausibleIpOrCidr('198.51.100.7'), true)
  assert.equal(isPlausibleIpOrCidr('not-an-ip'), false)
})

test('extractIpListSpecs trims fields and reads the ips list', () => {
  const [spec] = extractIpListSpecs(canvasOf([{ name: '  Offices  ', description: ' d ', ips: ['1.1.1.1'] }]))
  assert.equal(spec.name, 'Offices')
  assert.equal(spec.description, 'd')
  assert.deepEqual(spec.ips, ['1.1.1.1'])
  assert.equal(spec.itemId, 'i0')
})

test('buildIpListBody sends name, description and the full ips array', () => {
  const body = buildIpListBody({ name: 'N', description: 'D', ips: ['1.1.1.1'] })
  assert.deepEqual(body, { name: 'N', description: 'D', ips: ['1.1.1.1'] })
})

test('findIpListByName matches case-insensitively', () => {
  const lists: JumpCloudIpList[] = [{ id: 'a', name: 'Corp Offices' }, { id: 'b', name: 'VPN Egress' }]
  assert.equal(findIpListByName(lists, 'corp offices')?.id, 'a')
  assert.equal(findIpListByName(lists, 'MISSING'), null)
})

test('priorFieldsOf captures name, description and ips for rollback', () => {
  const prior = priorFieldsOf({ id: 'a', name: 'N', description: 'D', ips: ['1.1.1.1'] })
  assert.deepEqual(prior, { name: 'N', description: 'D', ips: ['1.1.1.1'] })
})
