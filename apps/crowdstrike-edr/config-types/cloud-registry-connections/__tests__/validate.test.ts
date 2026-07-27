import validate, {
  extractRegistrySpecs,
  hasCredential,
  parseScanInterval,
  type RegistrySpec,
} from '../validate'
import { buildRegistryBody, findByAlias } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-registry-connections',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-registry-connections',
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

function validRegistryFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Prod Docker Hub',
    url: 'docker.io',
    type: 'dockerhub',
    username: 'svc-scanner',
    credential: 'super-secret-token',
    enabled: true,
    scanInterval: '24',
    ...overrides,
  }
}

describe('CrowdStrike Registry Connections Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid registry configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Registry', fields: validRegistryFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validRegistryFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing url', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validRegistryFields({ url: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('url'))).toBe(true)
  })

  it('rejects a url containing whitespace', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRegistryFields({ url: 'docker io' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_url')).toBe(true)
  })

  it('rejects an unknown registry type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRegistryFields({ type: 'floppydisk' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('normalizes registry type casing', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRegistryFields({ type: 'ECR' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a non-numeric scan interval', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRegistryFields({ scanInterval: 'daily' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scan_interval')).toBe(true)
  })

  it('rejects a scan interval beyond the maximum', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRegistryFields({ scanInterval: '1000' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scan_interval')).toBe(true)
  })

  it('warns when no credential is supplied', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validRegistryFields({ credential: '', username: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_credential')).toBe(true)
  })

  it('rejects duplicate registry names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validRegistryFields() },
        { name: 'sec2', fields: validRegistryFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractRegistrySpecs', () => {
  it('captures the secret verbatim and lowercases the type', () => {
    const specs = extractRegistrySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-registry-connections',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: 'R1', url: 'quay.io', type: 'Quay', credential: '  P@ss  ' } },
      ],
      snapshot: {},
    })
    expect(specs[0].type).toBe('quay')
    expect(specs[0].credential).toBe('  P@ss  ')
    expect(hasCredential(specs[0])).toBe(true)
  })

  it('defaults enabled to true and leaves scanInterval undefined when unset', () => {
    const specs = extractRegistrySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-registry-connections',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'R1', url: 'docker.io', type: 'dockerhub' } }],
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].scanInterval).toBeUndefined()
  })
})

describe('parseScanInterval', () => {
  it('parses numeric strings', () => {
    expect(parseScanInterval('12')).toBe(12)
  })
  it('returns undefined for blank input', () => {
    expect(parseScanInterval('')).toBeUndefined()
  })
  it('passes through numbers', () => {
    expect(parseScanInterval(6)).toBe(6)
  })
})

describe('buildRegistryBody', () => {
  function spec(overrides: Partial<RegistrySpec> = {}): RegistrySpec {
    return {
      sectionName: 'sec1',
      name: 'Prod Docker Hub',
      url: 'docker.io',
      type: 'dockerhub',
      username: 'svc-scanner',
      credential: 'super-secret-token',
      scanInterval: 24,
      enabled: true,
      ...overrides,
    }
  }

  it('sends verified fields and nests the secret under credential.details.password', () => {
    const body = buildRegistryBody(spec()) as Record<string, unknown>
    expect(body.user_defined_alias).toBe('Prod Docker Hub')
    expect(body.url).toBe('docker.io')
    expect(body.type).toBe('dockerhub')
    expect(body.scan_interval).toBe(24)
    const credential = body.credential as { details: Record<string, unknown> }
    expect(credential.details.username).toBe('svc-scanner')
    expect(credential.details.password).toBe('super-secret-token')
  })

  it('omits the credential block entirely when no username or secret is supplied', () => {
    const body = buildRegistryBody(spec({ username: undefined, credential: '' })) as Record<string, unknown>
    expect(body.credential).toBeUndefined()
  })

  it('omits the password when only a username is supplied (non-secret update)', () => {
    const body = buildRegistryBody(spec({ credential: '' })) as Record<string, unknown>
    const credential = body.credential as { details: Record<string, unknown> }
    expect(credential.details.username).toBe('svc-scanner')
    expect(credential.details.password).toBeUndefined()
  })

  it('maps a disabled registry to the paused state', () => {
    const body = buildRegistryBody(spec({ enabled: false })) as Record<string, unknown>
    expect(body.state).toBe('paused')
  })
})

describe('findByAlias', () => {
  it('matches a registry by its user_defined_alias', () => {
    const found = findByAlias(
      [
        { id: '1', user_defined_alias: 'Other', url: 'a', type: 'ecr' },
        { id: '2', user_defined_alias: 'Prod Docker Hub', url: 'docker.io', type: 'dockerhub' },
      ],
      'Prod Docker Hub',
    )
    expect(found).toBeDefined()
    expect(found?.id).toBe('2')
  })

  it('returns null when no alias matches', () => {
    const found = findByAlias([{ id: '1', user_defined_alias: 'Other' }], 'Missing')
    expect(found).toBeNull()
  })
})
