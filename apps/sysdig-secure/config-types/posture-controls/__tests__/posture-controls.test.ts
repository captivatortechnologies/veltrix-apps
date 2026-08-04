import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildControlBody, normalizeBoolean, SEVERITIES } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'S3 - Enabled Versioning',
  description: 'S3 buckets must have versioning enabled',
  resourceKind: 'AWS_S3_BUCKET',
  severity: 'Low',
  enabled: true,
  rego: 'package sysdig\ndefault risky := false',
  remediationDetails: 'Enable versioning via the AWS CLI',
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing resourceKind', async () => {
  const res = await validate(ctxOf([{ ...good, resourceKind: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RESOURCE_KIND'))
})

test('validate rejects an invalid severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 'Critical' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects a missing rego', async () => {
  const res = await validate(ctxOf([{ ...good, rego: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REGO'))
})

test('validate rejects a missing remediationDetails', async () => {
  const res = await validate(ctxOf([{ ...good, remediationDetails: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REMEDIATION'))
})

test('validate accepts a good posture control for each severity', async () => {
  for (const severity of SEVERITIES) {
    const res = await validate(ctxOf([{ ...good, severity }]))
    assert.equal(res.valid, true, `expected ${severity} to be valid`)
  }
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('normalizeBoolean defaults and reads common truthy/falsy forms', () => {
  assert.equal(normalizeBoolean(undefined, true), true)
  assert.equal(normalizeBoolean('no', true), false)
})

test('buildControlBody maps fields and includes id only when given', () => {
  const created = buildControlBody(good)
  assert.equal(created.id, undefined)
  assert.equal(created.name, good.name)
  assert.equal(created.resourceKind, good.resourceKind)

  const updated = buildControlBody(good, 'ctl_123')
  assert.equal(updated.id, 'ctl_123')
})
