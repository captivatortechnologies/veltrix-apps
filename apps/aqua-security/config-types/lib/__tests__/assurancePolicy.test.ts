import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { buildAssurancePolicyBody, diffAssurancePolicy, extractAssurancePolicySpecs } from '../assurancePolicy'
import type { AquaAssurancePolicy } from '../../../lib/aquasec'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  return {
    items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields })),
  } as unknown as CanvasSnapshot
}

const goodFields = {
  name: 'prod-images-critical',
  description: 'Blocks critical CVEs in production images',
  applicationScopes: ['Global'],
  registries: [],
  enabled: true,
  enforce: true,
  blockFailed: true,
  failCicd: true,
  auditOnFailure: true,
  enforceAfterDays: 0,
  cvssSeverityEnabled: true,
  cvssSeverity: 'critical',
  maximumScoreEnabled: true,
  maximumScore: 9,
  disallowMalware: true,
  scanSensitiveData: true,
  dockerCisEnabled: true,
  requiredLabels: { team: 'platform' },
  scopeExpression: 'v1',
  scopeVariables: { 'image.repo': 'nginx' },
}

test('extractAssurancePolicySpecs maps canvas fields into a typed spec', () => {
  const [spec] = extractAssurancePolicySpecs(canvasOf([goodFields]))
  assert.equal(spec.name, 'prod-images-critical')
  assert.equal(spec.cvssSeverity, 'critical')
  assert.equal(spec.maximumScore, 9)
  assert.deepEqual(spec.applicationScopes, ['Global'])
})

test('buildAssurancePolicyBody maps a spec to the Aqua wire shape for a given type', () => {
  const [spec] = extractAssurancePolicySpecs(canvasOf([goodFields]))
  const body = buildAssurancePolicyBody(spec, 'image')
  assert.equal(body.name, 'prod-images-critical')
  assert.equal(body.assurance_type, 'image')
  assert.equal(body.cvss_severity, 'critical')
  assert.equal(body.maximum_score, 9)
  assert.deepEqual(body.required_labels, [{ key: 'team', value: 'platform' }])
  assert.deepEqual(body.scope, { expression: 'v1', variables: [{ attribute: 'image.repo', value: 'nginx' }] })
})

test('buildAssurancePolicyBody defaults application scope to Global when none declared', () => {
  const [spec] = extractAssurancePolicySpecs(canvasOf([{ ...goodFields, applicationScopes: [] }]))
  const body = buildAssurancePolicyBody(spec, 'host')
  assert.deepEqual(body.application_scopes, ['Global'])
  assert.equal(body.assurance_type, 'host')
})

test('diffAssurancePolicy reports no drift when the live policy matches the spec', () => {
  const [spec] = extractAssurancePolicySpecs(canvasOf([goodFields]))
  const live = buildAssurancePolicyBody(spec, 'image') as AquaAssurancePolicy
  const diffs = diffAssurancePolicy(spec, live)
  assert.deepEqual(diffs, [])
})

test('diffAssurancePolicy flags enforce mode and severity drift', () => {
  const [spec] = extractAssurancePolicySpecs(canvasOf([goodFields]))
  const live: AquaAssurancePolicy = {
    ...(buildAssurancePolicyBody(spec, 'image') as AquaAssurancePolicy),
    enforce: false,
    cvss_severity: 'low',
  }
  const diffs = diffAssurancePolicy(spec, live)
  assert.ok(diffs.some((d) => d.field === 'prod-images-critical.enforce' && d.severity === 'critical'))
  assert.ok(diffs.some((d) => d.field === 'prod-images-critical.cvssSeverity'))
})

test('diffAssurancePolicy flags a missing application-scope reassignment as critical', () => {
  const [spec] = extractAssurancePolicySpecs(canvasOf([goodFields]))
  const live: AquaAssurancePolicy = { ...(buildAssurancePolicyBody(spec, 'image') as AquaAssurancePolicy), application_scopes: ['Other'] }
  const diffs = diffAssurancePolicy(spec, live)
  const found = diffs.find((d) => d.field === 'prod-images-critical.applicationScopes')
  assert.ok(found)
  assert.equal(found?.severity, 'critical')
})
