import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateConfigCommand, buildModifyConfigCommand, buildDeleteConfigCommand, parseConfigs, SCAN_CONFIG_FULL_AND_FAST } from '../../../lib/gmp/scanConfigs'
import { buildScanConfigItem, findConfigByName, parseFamilySelectionField, parseNvtSelectionField, parsePreferencesField } from '../_shared'

// The deploy/rollback/health/drift handlers talk to gvmd over a live TLS
// socket, which cannot be mocked here (house convention). These tests exercise
// the pure, network-free seams: validate.ts, _shared.ts and the GMP command
// assembly + response parsing in lib/gmp/scanConfigs.ts.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Custom Full Fast', baseConfigId: SCAN_CONFIG_FULL_AND_FAST, comment: 'q1' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a non-UUID base config', async () => {
  const res = await validate(ctxOf([{ ...good, baseConfigId: 'full-and-fast' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BASE_CONFIG'))
})

test('validate rejects invalid familySelection JSON', async () => {
  const res = await validate(ctxOf([{ ...good, familySelection: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FAMILY_SELECTION'))
})

test('validate rejects a familySelection entry with no name', async () => {
  const res = await validate(ctxOf([{ ...good, familySelection: JSON.stringify([{ all: true }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FAMILY_SELECTION'))
})

test('validate rejects an nvtSelection entry missing oids', async () => {
  const res = await validate(ctxOf([{ ...good, nvtSelection: JSON.stringify([{ family: 'Windows' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NVT_SELECTION'))
})

test('validate rejects a preferences entry missing value', async () => {
  const res = await validate(ctxOf([{ ...good, preferences: JSON.stringify([{ name: 'timeout' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PREFERENCES'))
})

test('validate warns on a duplicate config name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good scan config with all JSON blocks', async () => {
  const res = await validate(
    ctxOf([
      {
        ...good,
        familySelection: JSON.stringify([{ name: 'Windows', all: true, growing: false }]),
        nvtSelection: JSON.stringify([{ family: 'Windows', oids: ['1.3.6.1.4.1.25623.1.0.1'] }]),
        preferences: JSON.stringify([{ name: 'Max hosts', value: '20' }]),
      },
    ]),
  )
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreateConfigCommand emits copy + name only (clone-only create)', () => {
  const xml = buildCreateConfigCommand(SCAN_CONFIG_FULL_AND_FAST, 'Custom Full Fast')
  assert.equal(xml, `<create_config><copy>${SCAN_CONFIG_FULL_AND_FAST}</copy><name>Custom Full Fast</name></create_config>`)
})

test('buildModifyConfigCommand emits family_selection, nvt_selection and base64 preference values', () => {
  const xml = buildModifyConfigCommand('cfg-1', {
    name: 'Renamed',
    comment: 'q2',
    familySelection: { growing: true, families: [{ name: 'Windows', all: true, growing: false }] },
    nvtSelections: [{ family: 'Windows', oids: ['1.2.3'] }],
    preferences: [{ name: 'timeout', nvtOid: '1.2.3', value: '60' }],
  })
  assert.ok(xml.startsWith('<modify_config config_id="cfg-1">'))
  assert.ok(xml.includes('<name>Renamed</name>'))
  assert.ok(xml.includes('<comment>q2</comment>'))
  assert.ok(xml.includes('<family_selection><growing>1</growing><family><name>Windows</name><all>1</all><growing>0</growing></family></family_selection>'))
  assert.ok(xml.includes('<nvt_selection><family>Windows</family><nvt oid="1.2.3"/></nvt_selection>'))
  assert.ok(xml.includes('<preference><name>timeout</name><nvt oid="1.2.3"/><value>NjA=</value></preference>')) // base64("60") = "NjA="
})

test('buildModifyConfigCommand omits undeclared sections', () => {
  const xml = buildModifyConfigCommand('cfg-1', { name: 'X' })
  assert.equal(xml, '<modify_config config_id="cfg-1"><name>X</name></modify_config>')
})

test('buildDeleteConfigCommand sets ultimate', () => {
  assert.equal(buildDeleteConfigCommand('cfg-1', true), '<delete_config config_id="cfg-1" ultimate="1"/>')
  assert.equal(buildDeleteConfigCommand('cfg-1', false), '<delete_config config_id="cfg-1" ultimate="0"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseConfigs extracts id, name and comment', () => {
  const xml = `<get_configs_response status="200"><config id="cfg-1"><name>Full and fast</name><comment>base</comment></config></get_configs_response>`
  const configs = parseConfigs(xml)
  assert.equal(configs.length, 1)
  assert.deepEqual(configs[0], { id: 'cfg-1', name: 'Full and fast', comment: 'base' })
})

// --- _shared helpers -----------------------------------------------------------

test('buildScanConfigItem defaults baseConfigId and parses JSON blocks', () => {
  const item = buildScanConfigItem({
    name: 'Custom',
    familySelection: JSON.stringify([{ name: 'Windows' }]),
    preferences: JSON.stringify([{ name: 'Max hosts', value: '5' }]),
  })
  assert.equal(item.name, 'Custom')
  assert.equal(item.baseConfigId, SCAN_CONFIG_FULL_AND_FAST)
  assert.equal(item.modify.familySelection?.families[0].name, 'Windows')
  assert.equal(item.modify.preferences?.[0].value, '5')
})

test('parseFamilySelectionField / parseNvtSelectionField / parsePreferencesField tolerate blank input', () => {
  assert.deepEqual(parseFamilySelectionField(''), { value: null, error: null })
  assert.deepEqual(parseNvtSelectionField(undefined), { value: null, error: null })
  assert.deepEqual(parsePreferencesField('   '), { value: null, error: null })
})

test('findConfigByName matches on the trimmed name', () => {
  const configs = parseConfigs('<get_configs_response><config id="cfg-1"><name>Full and fast</name></config></get_configs_response>')
  assert.equal(findConfigByName(configs, 'Full and fast')?.id, 'cfg-1')
  assert.equal(findConfigByName(configs, 'Nope'), null)
})
