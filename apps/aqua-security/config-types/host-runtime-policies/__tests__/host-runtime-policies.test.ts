import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return {
    canvas: { items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields })) },
  } as unknown as PipelineContext
}

const good = {
  name: 'prod-host-lockdown',
  applicationScopes: ['Global'],
  malwareScanEnabled: true,
  malwareScanAction: 'block',
  allowedExecutablesEnabled: true,
  allowedExecutables: ['/usr/bin/curl'],
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a policy with no application scopes', async () => {
  const res = await validate(ctxOf([{ ...good, applicationScopes: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPES'))
})

test('validate rejects an unknown malware action', async () => {
  const res = await validate(ctxOf([{ ...good, malwareScanAction: 'quarantine' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MALWARE_ACTION'))
})

test('validate warns when executable restriction has an empty allow-list', async () => {
  const res = await validate(ctxOf([{ ...good, allowedExecutables: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_ALLOWED_EXECUTABLES'))
})

test('validate warns on a duplicate policy name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})
