import validate, { extractNatRuleSpecs, natPackageKey, natRuleKey, liveInstallOnNames, liveNatMemberName } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'nat-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'nat-rules',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = { name: 'hide-outbound', package: 'Standard', method: 'hide', position: 'bottom' }

describe('Check Point NAT Rules Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { package: 'Standard' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing package', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'no-package' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('package'))).toBe(true)
  })

  it('requires a positionAnchor when position is above', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, position: 'above' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('positionAnchor'))).toBe(true)
  })

  it('accepts position below with a positionAnchor', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, position: 'below', positionAnchor: 'Cleanup NAT' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('allows the same rule name in two different packages', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, package: 'Standard' } },
        { name: 'b', fields: { ...validFields, package: 'DR' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate rule names within the same package', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Hide-Outbound' } },
        { name: 'b', fields: { ...validFields, name: 'hide-outbound' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('extractNatRuleSpecs falls back to safe defaults for unrecognized enums', () => {
    const specs = extractNatRuleSpecs(
      makeCtx([{ name: 'e', fields: { name: 'x', package: 'Standard', method: 'dynamic', position: 'middle' } }]).canvas,
    )
    expect(specs[0].method).toBe('hide')
    expect(specs[0].position).toBe('bottom')
  })

  it('extractNatRuleSpecs trims fields', () => {
    const specs = extractNatRuleSpecs(
      makeCtx([{ id: 'i1', name: 'e', fields: { name: '  nat-2  ', package: ' Standard ', originalSource: ' web-servers ' } }])
        .canvas,
    )
    expect(specs[0].name).toBe('nat-2')
    expect(specs[0].package).toBe('Standard')
    expect(specs[0].originalSource).toBe('web-servers')
    expect(natRuleKey('  Nat-2 ')).toBe('nat-2')
    expect(natPackageKey('  Standard ')).toBe('standard')
  })
})

describe('liveNatMemberName', () => {
  it('reads a plain string or an object summary', () => {
    expect(liveNatMemberName('Any')).toBe('Any')
    expect(liveNatMemberName({ name: 'Public-IP' })).toBe('Public-IP')
    expect(liveNatMemberName(undefined)).toBe('')
  })
})

describe('liveInstallOnNames', () => {
  it('flattens string and object-summary members', () => {
    expect(liveInstallOnNames(['gw-1', { name: 'gw-2' }])).toEqual(['gw-1', 'gw-2'])
  })

  it('tolerates a missing list', () => {
    expect(liveInstallOnNames(undefined)).toEqual([])
  })
})
