import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildEnforcerGroupBody, diffEnforcerGroup, extractEnforcerGroupSpecs } from '../_shared'
import type { PipelineContext, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { AquaEnforcerGroup } from '../../../lib/aquasec'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  return { items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.groupId ?? i), fields })) } as unknown as CanvasSnapshot
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = {
  groupId: 'prod-k8s-enforcers',
  logicalName: 'Prod Kubernetes Enforcers',
  type: 'kube_enforcer',
  orchestratorType: 'kubernetes',
  enforce: true,
  containerActivityProtection: true,
  imageAssurance: true,
  admissionControl: true,
  allowedRegistries: ['docker.io', 'gcr.io'],
}

test('validate rejects a missing group id', async () => {
  const res = await validate(ctxOf([{ ...good, groupId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUP_ID'))
})

test('validate rejects an invalid group id', async () => {
  const res = await validate(ctxOf([{ ...good, groupId: 'has a space' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP_ID'))
})

test('validate warns when admission control is on but enforce is off', async () => {
  const res = await validate(ctxOf([{ ...good, enforce: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ADMISSION_WITHOUT_ENFORCE'))
})

test('validate rejects an out-of-range schedule value', async () => {
  const res = await validate(ctxOf([{ ...good, scheduleScanDays: [8] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCHEDULE_VALUE'))
})

test('validate warns on a duplicate group id', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GROUP_ID'))
})

test('buildEnforcerGroupBody maps a spec to the Aqua wire shape', () => {
  const [spec] = extractEnforcerGroupSpecs(canvasOf([good]))
  const body = buildEnforcerGroupBody(spec)
  assert.equal(body.id, 'prod-k8s-enforcers')
  assert.equal(body.logicalname, 'Prod Kubernetes Enforcers')
  assert.equal(body.orchestrator?.type, 'kubernetes')
  assert.deepEqual(body.allowed_registries, ['docker.io', 'gcr.io'])
})

test('buildEnforcerGroupBody falls back to groupId when no display name is given', () => {
  const [spec] = extractEnforcerGroupSpecs(canvasOf([{ ...good, logicalName: '' }]))
  const body = buildEnforcerGroupBody(spec)
  assert.equal(body.logicalname, 'prod-k8s-enforcers')
})

test('diffEnforcerGroup reports no drift when the live group matches the spec', () => {
  const [spec] = extractEnforcerGroupSpecs(canvasOf([good]))
  const live = buildEnforcerGroupBody(spec) as AquaEnforcerGroup
  assert.deepEqual(diffEnforcerGroup(spec, live), [])
})

test('diffEnforcerGroup flags enforce and admission-control divergence as critical', () => {
  const [spec] = extractEnforcerGroupSpecs(canvasOf([good]))
  const live: AquaEnforcerGroup = { ...(buildEnforcerGroupBody(spec) as AquaEnforcerGroup), enforce: false, admission_control: false }
  const diffs = diffEnforcerGroup(spec, live)
  assert.ok(diffs.some((d) => d.field === 'prod-k8s-enforcers.enforce' && d.severity === 'critical'))
  assert.ok(diffs.some((d) => d.field === 'prod-k8s-enforcers.admissionControl' && d.severity === 'critical'))
})
