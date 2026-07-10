import validate, { extractIocSpecs, isValidIocValue, normalizeExpiration } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'custom-iocs',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'custom-iocs',
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const SHA256 = 'a'.repeat(64)

function validIocFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'sha256',
    value: SHA256,
    action: 'detect',
    severity: 'medium',
    platforms: 'windows, mac, linux',
    appliedGlobally: true,
    ...overrides,
  }
}

describe('CrowdStrike Custom IOCs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid IOC configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Indicator', fields: validIocFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing indicator value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validIocFields({ value: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a malformed hash value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ value: 'not-a-hash' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects prevent action on non-hash indicators', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validIocFields({ type: 'domain', value: 'evil.example.com', action: 'prevent' }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'action_type_conflict')).toBe(true)
  })

  it('allows prevent action on hashes', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ action: 'prevent' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects unknown platforms', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ platforms: 'windows, solaris' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('requires host groups when not applied globally', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validIocFields({ appliedGlobally: false, hostGroups: '' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('hostGroups'))).toBe(
      true,
    )
  })

  it('warns when host groups are set but ignored', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validIocFields({ appliedGlobally: true, hostGroups: 'group-1' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'host_groups_ignored')).toBe(true)
  })

  it('rejects duplicate indicators across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validIocFields() },
        { name: 'sec2', fields: validIocFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_indicator')).toBe(true)
  })

  it('rejects an expiration in the past', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ expiration: '2020-01-01T00:00:00Z' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'expired')).toBe(true)
  })

  it('accepts a future expiration date', async () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ expiration: nextYear }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('treats a string "false" appliedGlobally as not global and requires host groups', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validIocFields({ appliedGlobally: 'false', hostGroups: '' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('hostGroups'))).toBe(true)
  })

  it('rejects non-UTC expiration input that would parse as local time', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ expiration: '2099-12-31T18:00:00+02:00' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('warns that severity is ignored for allow indicators', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validIocFields({ action: 'allow', severity: 'high' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'severity_ignored')).toBe(true)
  })
})

describe('extractIocSpecs', () => {
  it('normalizes hash and domain values to lowercase', () => {
    const specs = extractIocSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'custom-iocs',
      sections: [
        { name: 'sec1', fields: { type: 'sha256', value: 'A'.repeat(64) } },
        { name: 'sec2', fields: { type: 'domain', value: 'EVIL.Example.COM' } },
      ],
      snapshot: {},
    })
    expect(specs[0].value).toBe('a'.repeat(64))
    expect(specs[1].value).toBe('evil.example.com')
  })
})

describe('value format checks', () => {
  it.each([
    ['sha256', 'f'.repeat(64), true],
    ['sha256', 'f'.repeat(63), false],
    ['md5', 'd'.repeat(32), true],
    ['ipv4', '203.0.113.10', true],
    ['ipv4', '203.0.113.999', false],
    ['ipv6', '2001:db8::1', true],
    ['domain', 'malicious.example.com', true],
    ['domain', 'not a domain', false],
  ])('%s %s → %s', (type, value, expected) => {
    expect(isValidIocValue(type as string, value as string)).toBe(expected)
  })
})

describe('normalizeExpiration', () => {
  it('expands date-only input to a UTC timestamp', () => {
    expect(normalizeExpiration('2026-12-31')).toBe('2026-12-31T00:00:00Z')
  })
  it('appends Z to seconds-precision input', () => {
    expect(normalizeExpiration('2026-12-31T12:00:00')).toBe('2026-12-31T12:00:00Z')
  })
  it('expands minutes-precision input to full UTC seconds', () => {
    expect(normalizeExpiration('2026-12-31T18:00')).toBe('2026-12-31T18:00:00Z')
  })
  it('leaves full UTC timestamps unchanged', () => {
    expect(normalizeExpiration('2026-12-31T12:00:00Z')).toBe('2026-12-31T12:00:00Z')
  })
})
