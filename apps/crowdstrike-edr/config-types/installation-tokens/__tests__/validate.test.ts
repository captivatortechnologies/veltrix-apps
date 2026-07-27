import validate, {
  extractInstallationTokenSpecs,
  normalizeExpiresTimestamp,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'installation-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'installation-tokens',
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

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'Workstation Rollout',
    expiresTimestamp: '2099-12-31T00:00:00Z',
    revoked: false,
    ...overrides,
  }
}

describe('CrowdStrike Installation Tokens Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid token configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a never-expiring token (empty expiry)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ expiresTimestamp: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing label', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ label: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate labels', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_token')).toBe(true)
  })

  it('rejects an invalid expiry timestamp', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ expiresTimestamp: 'next tuesday' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('warns when the expiry is in the past', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ expiresTimestamp: '2000-01-01T00:00:00Z' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'expired')).toBe(true)
  })

  it('warns when a token is deployed in a revoked state', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ revoked: true }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'revoked_on_deploy')).toBe(true)
  })
})

describe('extractInstallationTokenSpecs', () => {
  it('parses label, expiry, and revoke state; defaults revoked to false', () => {
    const sections = [
      { name: 'sec1', fields: { label: 'Rollout', expiresTimestamp: '2099-12-31T00:00:00Z' } },
    ]
    const specs = extractInstallationTokenSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'installation-tokens',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].label).toBe('Rollout')
    expect(specs[0].expiresTimestamp).toBe('2099-12-31T00:00:00Z')
    expect(specs[0].revoked).toBe(false)
  })

  it('normalizes a date-only expiry to a full RFC3339 UTC timestamp', () => {
    const sections = [{ name: 'sec1', fields: { label: 'A', expiresTimestamp: '2099-12-31' } }]
    const specs = extractInstallationTokenSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'installation-tokens',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].expiresTimestamp).toBe('2099-12-31T00:00:00Z')
  })

  it('coerces a string "true" revoked flag to a boolean', () => {
    const sections = [{ name: 'sec1', fields: { label: 'A', revoked: 'true' } }]
    const specs = extractInstallationTokenSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'installation-tokens',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].revoked).toBe(true)
    expect(specs[0].expiresTimestamp).toBe('')
  })
})

describe('normalizeExpiresTimestamp', () => {
  it('appends midnight UTC to a date-only value', () => {
    expect(normalizeExpiresTimestamp('2026-06-01')).toBe('2026-06-01T00:00:00Z')
  })

  it('appends seconds and Z to a minute-precision value', () => {
    expect(normalizeExpiresTimestamp('2026-06-01T08:30')).toBe('2026-06-01T08:30:00Z')
  })

  it('leaves a full RFC3339 UTC timestamp unchanged', () => {
    expect(normalizeExpiresTimestamp('2026-06-01T08:30:00Z')).toBe('2026-06-01T08:30:00Z')
  })
})
