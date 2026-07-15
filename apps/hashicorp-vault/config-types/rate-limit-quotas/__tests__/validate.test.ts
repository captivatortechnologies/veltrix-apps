import validate, {
  extractQuotaSpecs,
  isValidVaultDuration,
  parseDurationSeconds,
  toRate,
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
    configTypeId: 'rate-limit-quotas',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'rate-limit-quotas',
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
    entityType: 'rate-limit-quotas',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Rate Limit Quotas Validate Handler', () => {
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
          fields: { name: 'kv-reads', path: 'secret/*', rate: 1000, interval: '1s', blockInterval: '30s', role: '' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    // A scoped (non-empty) path does not raise the global-quota warning.
    expect(result.warnings.some((w) => w.code === 'global_quota')).toBe(false)
  })

  it('accepts an empty path but WARNS that it is the global limiter', async () => {
    const result = await validate(makeCtx([{ name: 'Quota', fields: { name: 'global-limit', path: '', rate: 500 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.some((w) => w.code === 'global_quota')).toBe(true)
  })

  it('treats a missing path field as the global limiter (warns, still valid)', async () => {
    const result = await validate(makeCtx([{ name: 'Quota', fields: { name: 'global-limit', rate: 500 } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'global_quota')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { rate: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing rate', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'no-rate', path: 'secret/' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rate'))).toBe(true)
  })

  it('rejects a non-positive rate', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'zero', path: 'secret/', rate: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rate')).toBe(true)
  })

  it('rejects a negative rate', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'neg', path: 'secret/', rate: -5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rate')).toBe(true)
  })

  it('accepts a fractional (sub-1) rate', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'slow', path: 'secret/', rate: 0.5 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'bad name!', path: 'secret/', rate: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a scope path with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'bad path!', rate: 100 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_path')).toBe(true)
  })

  it('rejects an invalid interval', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'secret/', rate: 100, interval: '1 second' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_interval')).toBe(true)
  })

  it('rejects an invalid block interval', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'secret/', rate: 100, blockInterval: 'nope' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_block_interval')).toBe(true)
  })

  it('accepts "0s" as a block interval', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'secret/', rate: 100, blockInterval: '0s' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate quota name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'q1', fields: { name: 'dup', path: 'secret/', rate: 100 } },
        { name: 'q2', fields: { name: 'dup', path: 'auth/', rate: 200 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('allows two distinct quota names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'q1', fields: { name: 'reads', path: 'secret/', rate: 100 } },
        { name: 'q2', fields: { name: 'writes', path: 'auth/', rate: 200 } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('does NOT special-case a quota named "default" (Vault OSS has no reserved name)', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'default', path: 'secret/', rate: 100 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a rate supplied as a numeric string', async () => {
    const result = await validate(makeCtx([{ name: 'q1', fields: { name: 'q', path: 'secret/', rate: '250' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractQuotaSpecs', () => {
  it('trims strings, coerces the rate, preserves an empty path and drops empty optionals', () => {
    const specs = extractQuotaSpecs(
      makeCanvas([
        {
          name: 'q1',
          fields: {
            name: '  global-limit  ',
            path: '   ',
            rate: '897.3',
            interval: '1s',
            blockInterval: '  ',
            role: '',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('global-limit')
    // A blank path is preserved as "" (the global limiter), not folded to undefined.
    expect(specs[0].path).toBe('')
    expect(specs[0].rate).toBe(897.3)
    expect(specs[0].interval).toBe('1s')
    expect(specs[0].blockInterval).toBeUndefined()
    expect(specs[0].role).toBeUndefined()
  })

  it('yields NaN for a missing rate so validate can flag it required', () => {
    const specs = extractQuotaSpecs(makeCanvas([{ name: 'q1', fields: { name: 'q', path: 'secret/' } }]))
    expect(Number.isNaN(specs[0].rate)).toBe(true)
  })
})

describe('toRate', () => {
  it('passes numbers through and parses numeric strings', () => {
    expect(toRate(1000)).toBe(1000)
    expect(toRate('250.5')).toBe(250.5)
  })
  it('returns NaN for blank or missing input', () => {
    expect(Number.isNaN(toRate(''))).toBe(true)
    expect(Number.isNaN(toRate(undefined))).toBe(true)
  })
})

describe('isValidVaultDuration', () => {
  it('accepts durations, plain seconds and zero', () => {
    expect(isValidVaultDuration('1s')).toBe(true)
    expect(isValidVaultDuration('0s')).toBe(true)
    expect(isValidVaultDuration('1h30m')).toBe(true)
    expect(isValidVaultDuration('3600')).toBe(true)
  })
  it('rejects malformed durations', () => {
    expect(isValidVaultDuration('1 second')).toBe(false)
    expect(isValidVaultDuration('')).toBe(false)
    expect(isValidVaultDuration('abc')).toBe(false)
  })
})

describe('parseDurationSeconds', () => {
  it('parses plain seconds and unit durations', () => {
    expect(parseDurationSeconds('1s')).toBe(1)
    expect(parseDurationSeconds('0s')).toBe(0)
    expect(parseDurationSeconds('1m')).toBe(60)
    expect(parseDurationSeconds('3600')).toBe(3600)
  })
  it('returns undefined for blank or unparseable input', () => {
    expect(parseDurationSeconds(undefined)).toBeUndefined()
    expect(parseDurationSeconds('')).toBeUndefined()
    expect(parseDurationSeconds('nope')).toBeUndefined()
  })
})
