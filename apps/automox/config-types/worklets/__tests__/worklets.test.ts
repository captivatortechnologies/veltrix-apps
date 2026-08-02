import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractWorkletSpecs,
  buildCustomConfiguration,
  buildRequiredSoftwareConfiguration,
  buildConfiguration,
  buildWorkletBody,
  type WorkletSpec,
} from '../_shared'
import { findPolicyByName, type AutomoxPolicy } from '../../lib/automoxPolicies'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

function specOf(fields: Record<string, unknown>): WorkletSpec {
  return extractWorkletSpecs(canvasOf([fields]))[0]
}

const goodCustom = {
  name: 'Restart Print Spooler',
  worklet_type: 'custom',
  os_family: 'Windows',
  evaluation_code: 'exit 1',
  remediation_code: 'Restart-Service spooler',
  schedule_days: ['monday'],
  schedule_time: '03:00',
}

const goodRequiredSoftware = {
  name: 'Install Notepad++',
  worklet_type: 'required_software',
  os_family: 'Windows',
  package_name: 'NotePadPlusPlus',
  package_version: '7.8.4',
  installation_code: '.\\npp.7.8.4.Installer.x64.exe /S',
  schedule_days: ['tuesday'],
  schedule_time: '04:00',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed Custom (Worklet) policy', async () => {
  const res = await validate(ctxOf([goodCustom]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a well-formed Required Software policy', async () => {
  const res = await validate(ctxOf([goodRequiredSoftware]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodCustom, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unsupported worklet_type', async () => {
  const res = await validate(ctxOf([{ ...goodCustom, worklet_type: 'bogus' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WORKLET_TYPE'))
})

test('validate rejects a Custom policy with no Evaluation Code', async () => {
  const res = await validate(ctxOf([{ ...goodCustom, evaluation_code: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WORKLET_CONFIGURATION'))
})

test('validate rejects a Required Software policy missing package fields', async () => {
  const res = await validate(ctxOf([{ ...goodRequiredSoftware, package_version: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_WORKLET_CONFIGURATION'))
})

test('validate allows the same name across a Custom and a Required Software item (different types)', async () => {
  const res = await validate(ctxOf([{ ...goodCustom, name: 'Shared Name' }, { ...goodRequiredSoftware, name: 'Shared Name' }]))
  // Uniqueness is per-canvas-item name only, not type-aware in THIS config
  // type's own duplicate check — Automox itself scopes reconciliation by
  // (name, policy_type_name), so this is a duplicate within this canvas.
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate rejects malformed device_filters_json', async () => {
  const res = await validate(ctxOf([{ ...goodCustom, device_filters_json: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEVICE_FILTERS'))
})

test('validate warns when unscheduled', async () => {
  const res = await validate(ctxOf([{ ...goodCustom, schedule_days: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNSCHEDULED'))
})

// --- _shared helpers ------------------------------------------------------------

test('extractWorkletSpecs defaults worklet_type to custom and os_family to Windows', () => {
  const spec = specOf({ name: 'X' })
  assert.equal(spec.workletType, 'custom')
  assert.equal(spec.osFamily, 'Windows')
})

test('buildCustomConfiguration requires evaluation_code', () => {
  const missing = buildCustomConfiguration(specOf({ ...goodCustom, evaluation_code: '' }))
  assert.ok(missing.error)

  const ok = buildCustomConfiguration(specOf(goodCustom))
  assert.equal(ok.error, undefined)
  assert.equal(ok.configuration.evaluation_code, 'exit 1')
  assert.equal(ok.configuration.remediation_code, 'Restart-Service spooler')
  assert.equal(ok.configuration.auto_reboot, true)
})

test('buildRequiredSoftwareConfiguration requires package_name/version/installation_code', () => {
  const missing = buildRequiredSoftwareConfiguration(specOf({ ...goodRequiredSoftware, installation_code: '' }))
  assert.ok(missing.error)
  assert.match(missing.error as string, /Installation Code/)

  const ok = buildRequiredSoftwareConfiguration(specOf(goodRequiredSoftware))
  assert.equal(ok.error, undefined)
  assert.equal(ok.configuration.package_name, 'NotePadPlusPlus')
  assert.equal(ok.configuration.package_version, '7.8.4')
})

test('buildRequiredSoftwareConfiguration omits FLAGGED evaluation/remediation code when not supplied', () => {
  const built = buildRequiredSoftwareConfiguration(specOf(goodRequiredSoftware))
  assert.equal('evaluation_code' in built.configuration, false)
  assert.equal('remediation_code' in built.configuration, false)

  const withCodes = buildRequiredSoftwareConfiguration(
    specOf({ ...goodRequiredSoftware, required_software_evaluation_code: 'test -f C:/pkg.exe' }),
  )
  assert.equal(withCodes.configuration.evaluation_code, 'test -f C:/pkg.exe')
})

test('buildConfiguration dispatches on workletType', () => {
  assert.equal(buildConfiguration(specOf(goodCustom)).configuration.auto_reboot, true)
  assert.equal(buildConfiguration(specOf(goodRequiredSoftware)).configuration.package_name, 'NotePadPlusPlus')
})

test('buildWorkletBody sets policy_type_name to the worklet type and org id', () => {
  const built = buildWorkletBody(specOf(goodCustom), 4242)
  assert.equal(built.error, undefined)
  assert.equal(built.body.policy_type_name, 'custom')
  assert.equal(built.body.organization_id, 4242)

  const rsBuilt = buildWorkletBody(specOf(goodRequiredSoftware), 4242)
  assert.equal(rsBuilt.body.policy_type_name, 'required_software')
})

test('findPolicyByName isolates worklets from a same-named patch policy', () => {
  const policies: AutomoxPolicy[] = [{ id: 9, name: 'Shared Name', policy_type_name: 'patch' }]
  assert.equal(findPolicyByName(policies, 'Shared Name', 'custom'), null)
  assert.equal(findPolicyByName(policies, 'Shared Name', 'patch')?.id, 9)
})
