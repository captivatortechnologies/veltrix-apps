import validate, {
  extractLeaseCountQuotaSpecs,
  coerceBoolean,
  toMaxLeases,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'lease-count-quotas',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'lease-count-quotas',
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
    toolType: 'hashicorp-vault',
    entityType: 'lease-count-quotas',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Lease Count Quotas Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a scoped quota with all fields', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Quota',
          fields: { name: 'db-leases', path: 'database/*', maxLeases: 500, role: '', inheritable: true },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.some((w) => w.code === 'global_quota')).toBe(false)
  })

  it('accepts an empty path but WARNS that it is the global limiter', async () => {
    const result = await validate(makeCtx([{ name: 'Quota', fields: { name: 'global-cap', path: '', maxLeases: 1000 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'global_quota')).toBe(true)
  })

  it('treats a missing path field as the global limiter (warns, still valid)', async () => {
    const result = await validate(makeCtx([{ name: 'Quota', fields: { name: 'global-cap', maxLeases: 1000 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'global_quota')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { maxLeases: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing max leases', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'no-cap', path: 'secret/' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('maxLeases'))).toBe(true)
  })

  it('rejects a zero max leases', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'zero', path: 'secret/', maxLeases: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_max_leases')).toBe(true)
  })

  it('rejects a negative max leases', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'neg', path: 'secret/', maxLeases: -5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_max_leases')).toBe(true)
  })

  it('rejects a fractional max leases', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'frac', path: 'secret/', maxLeases: 5.5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_max_leases')).toBe(true)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'bad name!', path: 'secret/', maxLeases: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a scope path with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'bad path!', maxLeases: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects a duplicate quota name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'q1', fields: { name: 'dup', path: 'secret/', maxLeases: 100 } },
        { name: 'q2', fields: { name: 'dup', path: 'auth/', maxLeases: 200 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows two distinct quota names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'q1', fields: { name: 'reads', path: 'secret/', maxLeases: 100 } },
        { name: 'q2', fields: { name: 'writes', path: 'auth/', maxLeases: 200 } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts max leases supplied as a numeric string', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'secret/', maxLeases: '250' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractLeaseCountQuotaSpecs', () => {
  it('trims strings, coerces maxLeases/inheritable, preserves an empty path and drops empty optionals', () => {
    const specs = extractLeaseCountQuotaSpecs(
      makeCanvas([
        {
          name: 'q1',
          fields: {
            name: '  global-cap  ',
            path: '   ',
            maxLeases: '897',
            role: '',
            inheritable: 'true',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('global-cap')
    // A blank path is preserved as "" (the global limiter), not folded to undefined.
    expect(specs[0].path).toBe('')
    expect(specs[0].maxLeases).toBe(897)
    expect(specs[0].role).toBeUndefined()
    expect(specs[0].inheritable).toBe(true)
  })

  it('yields NaN for a missing maxLeases so validate can flag it required', () => {
    const specs = extractLeaseCountQuotaSpecs(makeCanvas([{ name: 'q1', fields: { name: 'q', path: 'secret/' } }]))
    expect(Number.isNaN(specs[0].maxLeases)).toBe(true)
  })

  it('defaults inheritable to false when unset', () => {
    const specs = extractLeaseCountQuotaSpecs(makeCanvas([{ name: 'q1', fields: { name: 'q', maxLeases: 10 } }]))
    expect(specs[0].inheritable).toBe(false)
  })
})

describe('toMaxLeases', () => {
  it('passes numbers through and parses numeric strings', () => {
    expect(toMaxLeases(1000)).toBe(1000)
    expect(toMaxLeases('250')).toBe(250)
  })
  it('returns NaN for blank or missing input', () => {
    expect(Number.isNaN(toMaxLeases(''))).toBe(true)
    expect(Number.isNaN(toMaxLeases(undefined))).toBe(true)
  })
})

describe('coerceBoolean', () => {
  it('coerces common truthy/falsy representations', () => {
    expect(coerceBoolean(true, false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
    expect(coerceBoolean('0', true)).toBe(false)
    expect(coerceBoolean('true', false)).toBe(true)
  })
  it('falls back when unset', () => {
    expect(coerceBoolean(undefined, true)).toBe(true)
    expect(coerceBoolean('', false)).toBe(false)
  })
})
