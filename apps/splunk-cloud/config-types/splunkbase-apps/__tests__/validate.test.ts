import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'splunkbase-apps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-cloud',
      entityType: 'splunkbase-apps',
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

const VALID_FIELDS = {
  appName: 'SplunkforPaloAltoNetworks',
  splunkbaseId: '491',
  licenseAck: 'http://opensource.org/licenses/ISC',
}

describe('Splunk Cloud Splunkbase Apps Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed Splunkbase app declaration', async () => {
    const result = await validate(makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a numeric splunkbaseId', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS, splunkbaseId: 491 } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing app name', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { splunkbaseId: '491', licenseAck: 'http://x.example/license' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'app1.appName' && e.code === 'required')).toBe(true)
  })

  it('rejects an app name with invalid characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS, appName: '1-bad name!' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'app1.appName' && e.code === 'invalid_format')).toBe(true)
  })

  it('rejects duplicate app names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'app1', fields: { ...VALID_FIELDS } },
        { name: 'app2', fields: { ...VALID_FIELDS, splunkbaseId: '999' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('rejects a missing Splunkbase id', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { appName: 'MyApp', licenseAck: 'http://x.example/license' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'app1.splunkbaseId' && e.code === 'required')).toBe(true)
  })

  it('rejects a non-numeric Splunkbase id', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS, splunkbaseId: 'abc' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'app1.splunkbaseId' && e.code === 'invalid_format')).toBe(true)
  })

  it('warns on duplicate Splunkbase ids across different app names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'app1', fields: { ...VALID_FIELDS, appName: 'AppOne' } },
        { name: 'app2', fields: { ...VALID_FIELDS, appName: 'AppTwo' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'duplicate_id')).toBe(true)
  })

  it('rejects a missing license acknowledgement URL', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { appName: 'MyApp', splunkbaseId: '491' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'app1.licenseAck' && e.code === 'required')).toBe(true)
  })

  it('rejects a license URL without a scheme', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS, licenseAck: 'opensource.org/licenses/ISC' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'app1.licenseAck' && e.code === 'invalid_format')).toBe(true)
  })

  it('warns when a version is declared (no-downgrade reminder)', async () => {
    const result = await validate(
      makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS, version: '7.0.3' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_downgrade')).toBe(true)
  })

  it('always warns about self-service install limitations', async () => {
    const result = await validate(makeCtx([{ name: 'app1', fields: { ...VALID_FIELDS } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'self_service_reminder')).toBe(true)
  })

  it('validates multiple app sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'app1', fields: { ...VALID_FIELDS, appName: 'AppOne', splunkbaseId: '111' } },
        { name: 'app2', fields: { ...VALID_FIELDS, appName: 'AppTwo', splunkbaseId: '222' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
