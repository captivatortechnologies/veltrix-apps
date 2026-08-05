import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { buildRuntimePolicyBody, diffRuntimePolicy, extractRuntimePolicySpecs } from '../runtimePolicy'
import type { AquaRuntimePolicy } from '../../../lib/aquasec'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  return {
    items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields })),
  } as unknown as CanvasSnapshot
}

const goodFields = {
  name: 'prod-container-lockdown',
  description: 'Locks down drift and reverse shells in production',
  applicationScopes: ['Global'],
  enabled: true,
  enforce: true,
  driftPreventionEnabled: true,
  execLockdown: true,
  imageLockdown: true,
  allowedExecutablesEnabled: true,
  allowedExecutables: ['/usr/bin/curl'],
  reverseShellEnabled: true,
  blockReverseShell: true,
  auditAllProcesses: true,
  scopeExpression: 'v1',
  scopeVariables: { 'kubernetes.namespace': 'prod' },
}

test('extractRuntimePolicySpecs maps canvas fields into a typed spec', () => {
  const [spec] = extractRuntimePolicySpecs(canvasOf([goodFields]))
  assert.equal(spec.name, 'prod-container-lockdown')
  assert.equal(spec.execLockdown, true)
  assert.deepEqual(spec.allowedExecutables, ['/usr/bin/curl'])
})

test('buildRuntimePolicyBody maps a spec to the Aqua wire shape for a given runtime type', () => {
  const [spec] = extractRuntimePolicySpecs(canvasOf([goodFields]))
  const body = buildRuntimePolicyBody(spec, 'container')
  assert.equal(body.name, 'prod-container-lockdown')
  assert.equal(body.type, 'container')
  assert.equal(body.drift_prevention?.exec_lockdown, true)
  assert.deepEqual(body.allowed_executables?.allow_executables, ['/usr/bin/curl'])
  assert.deepEqual(body.scope, { expression: 'v1', variables: [{ attribute: 'kubernetes.namespace', value: 'prod' }] })
})

test('buildRuntimePolicyBody defaults application scope to Global when none declared', () => {
  const [spec] = extractRuntimePolicySpecs(canvasOf([{ ...goodFields, applicationScopes: [] }]))
  const body = buildRuntimePolicyBody(spec, 'host')
  assert.deepEqual(body.application_scopes, ['Global'])
  assert.equal(body.type, 'host')
})

test('diffRuntimePolicy reports no drift when the live policy matches the spec', () => {
  const [spec] = extractRuntimePolicySpecs(canvasOf([goodFields]))
  const live = buildRuntimePolicyBody(spec, 'container') as AquaRuntimePolicy
  assert.deepEqual(diffRuntimePolicy(spec, live), [])
})

test('diffRuntimePolicy flags enforce and drift-prevention divergence', () => {
  const [spec] = extractRuntimePolicySpecs(canvasOf([goodFields]))
  const live: AquaRuntimePolicy = {
    ...(buildRuntimePolicyBody(spec, 'container') as AquaRuntimePolicy),
    enforce: false,
    drift_prevention: { enabled: false, exec_lockdown: false, image_lockdown: false },
  }
  const diffs = diffRuntimePolicy(spec, live)
  assert.ok(diffs.some((d) => d.field === 'prod-container-lockdown.enforce' && d.severity === 'critical'))
  assert.ok(diffs.some((d) => d.field === 'prod-container-lockdown.driftPreventionEnabled'))
})
