import validate, { extractDeviceAssuranceSpecs, parseConfigObject } from '../validate'
import {
  buildDeviceAssuranceBody,
  stripReadOnlyDeviceAssuranceFields,
  type DeviceAssuranceRollbackEntry,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'device-assurance-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'device-assurance-policies',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'device-assurance-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

const MACOS_CONFIG = '{"diskEncryptionType":{"include":["ALL_INTERNAL_VOLUMES"]},"screenLockType":{"include":["BIOMETRIC"]},"osVersion":{"minimum":"14.0.0"}}'

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'macOS Baseline', platform: 'MACOS', configJson: MACOS_CONFIG, ...over }
}

describe('Okta Device Assurance Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid macOS policy', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing platform', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ platform: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('platform'))).toBe(true)
  })

  it('rejects an unknown platform', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ platform: 'LINUX' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('rejects missing requirements JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ configJson: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('configJson'))).toBe(true)
  })

  it('rejects malformed requirements JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ configJson: '{nope' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects an empty requirements object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ configJson: '{}' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_requirement')).toBe(true)
  })

  it('rejects a requirements value that is a JSON array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ configJson: '[1,2]' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects a duplicate policy name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ name: 'Baseline' }) },
        { name: 'sec2', fields: validFields({ name: 'baseline' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractDeviceAssuranceSpecs', () => {
  it('trims fields, upper-cases the platform and drops a blank config', () => {
    const specs = extractDeviceAssuranceSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: '  Win Baseline  ', platform: ' windows ', configJson: '   ' } }]),
    )
    expect(specs[0].name).toBe('Win Baseline')
    expect(specs[0].platform).toBe('WINDOWS')
    expect(specs[0].configJson).toBeUndefined()
  })
})

describe('buildDeviceAssuranceBody', () => {
  it('merges the requirements and lets the modeled fields win over the blob', () => {
    const body = buildDeviceAssuranceBody(
      { sectionName: 's', name: 'macOS Baseline', platform: 'MACOS' },
      { screenLockType: { include: ['BIOMETRIC'] }, name: 'HIJACK', platform: 'WINDOWS' },
    )
    expect(body).toEqual({
      platform: 'MACOS',
      name: 'macOS Baseline',
      screenLockType: { include: ['BIOMETRIC'] },
    })
  })
})

describe('stripReadOnlyDeviceAssuranceFields', () => {
  it('removes id/createdBy/createdDate/lastUpdate/lastUpdatedBy/_links but keeps requirements', () => {
    const stripped = stripReadOnlyDeviceAssuranceFields({
      id: 'dae1',
      name: 'macOS Baseline',
      platform: 'MACOS',
      createdBy: 'admin',
      createdDate: '2020-01-01T00:00:00Z',
      lastUpdate: '2020-01-02T00:00:00Z',
      lastUpdatedBy: 'admin',
      _links: { self: {} },
      screenLockType: { include: ['BIOMETRIC'] },
    })
    expect(stripped).toEqual({
      name: 'macOS Baseline',
      platform: 'MACOS',
      screenLockType: { include: ['BIOMETRIC'] },
    })
    expect(stripped.id).toBeUndefined()
  })
})

describe('parseConfigObject', () => {
  it('parses an object and rejects arrays/garbage', () => {
    expect(parseConfigObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseConfigObject('[1]')).toBe(null)
    expect(parseConfigObject('{bad')).toBe(null)
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: DeviceAssuranceRollbackEntry | null = null
void _rollbackEntryType
