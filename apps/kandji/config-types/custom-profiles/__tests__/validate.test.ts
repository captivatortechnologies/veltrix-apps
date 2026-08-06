import validate, {
  buildCustomProfileForm,
  customProfileKey,
  extractCustomProfileSpecs,
  indexCustomProfilesByName,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'kandji',
    customerId: 'cust-1',
    configTypeId: 'custom-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'kandji',
      entityType: 'custom-profiles',
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

const PLIST = '<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict/></plist>'

describe('Kandji Custom Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid custom profile', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Restrictions', profile: PLIST, runs_on_mac: true } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { profile: PLIST, runs_on_mac: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing payload', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Restrictions', runs_on_mac: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.profile') && e.code === 'required')).toBe(true)
  })

  it('warns when the payload does not look like a plist', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'Restrictions', profile: 'not a plist', runs_on_mac: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'payload_shape')).toBe(true)
  })

  it('rejects a profile with no target platform enabled', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec',
          fields: { name: 'Restrictions', profile: PLIST, runs_on_mac: false, runs_on_iphone: false, runs_on_ipad: false, runs_on_tv: false },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_target_platform')).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Restrictions', profile: PLIST, runs_on_mac: true } },
        { name: 'b', fields: { name: 'restrictions', profile: PLIST, runs_on_mac: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_custom_profile')).toBe(true)
  })

  it('customProfileKey normalizes case and whitespace', () => {
    expect(customProfileKey('  Restrictions ')).toBe('restrictions')
  })

  it('extractCustomProfileSpecs defaults runs_on_mac to true and others to false', () => {
    const specs = extractCustomProfileSpecs(makeCtx([{ name: 'sec', fields: { name: 'X', profile: PLIST } }]).canvas)
    expect(specs[0].runsOnMac).toBe(true)
    expect(specs[0].runsOnIphone).toBe(false)
  })

  it('buildCustomProfileForm produces a FormData with the profile as a file part', () => {
    const specs = extractCustomProfileSpecs(
      makeCtx([{ name: 'sec', fields: { name: 'Restrictions', profile: PLIST, runs_on_mac: true } }]).canvas,
    )
    const form = buildCustomProfileForm(specs[0])
    expect(form.get('name')).toBe('Restrictions')
    expect(form.get('runs_on_mac')).toBe('true')
    const file = form.get('file')
    expect(file).toBeTruthy()
  })

  it('indexCustomProfilesByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexCustomProfilesByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })
})
