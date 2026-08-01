import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractInternalDomainSpecs, isDomain } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella Deployments API,
 * which is impractical to mock here. Tests focus on the pure, network-free
 * pieces: validate.ts and the _shared parsing helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { domain: 'corp.example.com', description: 'Corp AD', includeAllVAs: true, includeAllMobileDevices: false }

test('validate accepts a valid internal domain', () => {
  const res = validate(ctxWith([{ fields: good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', () => {
  const res = validate(ctxWith([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a domain', () => {
  const res = validate(ctxWith([{ name: '', fields: { ...good, domain: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'required'))
})

test('validate rejects a malformed domain', () => {
  const res = validate(ctxWith([{ fields: { ...good, domain: 'not a domain' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_domain'))
})

test('validate rejects duplicate domains', () => {
  const res = validate(ctxWith([{ fields: good }, { fields: { ...good } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_domain'))
})

test('validate warns when no scope is enabled', () => {
  const res = validate(ctxWith([{ fields: { ...good, includeAllVAs: false, includeAllMobileDevices: false } }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'no_scope'))
})

test('isDomain accepts domains and wildcards, rejects junk', () => {
  assert.equal(isDomain('example.com'), true)
  assert.equal(isDomain('corp.ad.example.com'), true)
  assert.equal(isDomain('*.internal.example.com'), true)
  assert.equal(isDomain('example'), false)
  assert.equal(isDomain('http://example.com'), false)
})

test('extractInternalDomainSpecs reads fields with defaults and coercions', () => {
  const specs = extractInternalDomainSpecs({
    items: [{ id: 'i1', name: 'Fallback', fields: { domain: '  Corp.Example.com  ', includeAllVAs: 'true', includeAllMobileDevices: 1 } }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].domain, 'Corp.Example.com')
  assert.equal(specs[0].includeAllVAs, true)
  assert.equal(specs[0].includeAllMobileDevices, true)
})
