import validate, {
  extractProfileSpecs,
  indexProfilesByName,
  parseProfileGeneralXml,
  parseProfileScopeXml,
  profileKey,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'macos-configuration-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'macos-configuration-profiles',
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

const PLIST = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>PayloadType</key><string>Configuration</string></dict></plist>'

describe('Jamf macOS Configuration Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid profile', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'WiFi Profile', payloads: PLIST } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { payloads: PLIST } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing payload', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'WiFi Profile' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('payloads') && e.code === 'required')).toBe(true)
  })

  it('warns (but does not fail) when the payload does not look like a plist', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'WiFi Profile', payloads: 'not a plist' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'payload_shape')).toBe(true)
  })

  it('rejects an unsupported distribution method', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { name: 'x', payloads: PLIST, distribution_method: 'Push Now' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_distribution_method')).toBe(true)
  })

  it('rejects an unsupported level', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'x', payloads: PLIST, level: 'device' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_level')).toBe(true)
  })

  it('rejects duplicate profile names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'WiFi Profile', payloads: PLIST } },
        { name: 'b', fields: { name: 'wifi profile', payloads: PLIST } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_profile')).toBe(true)
  })

  it('profileKey normalizes case and whitespace', () => {
    expect(profileKey('  WiFi Profile ')).toBe('wifi profile')
  })

  it('extractProfileSpecs defaults distribution_method/level/user_removable and reads scope', () => {
    const specs = extractProfileSpecs(
      makeCtx([
        { name: 'sec', fields: { name: 'WiFi Profile', payloads: PLIST, all_computers: true, computer_group_names: ['Fleet A'] } },
      ]).canvas,
    )
    expect(specs[0].distributionMethod).toBe('Install Automatically')
    expect(specs[0].level).toBe('computer')
    expect(specs[0].userRemovable).toBe(true)
    expect(specs[0].allComputers).toBe(true)
    expect(specs[0].computerGroupNames).toEqual(['Fleet A'])
    expect(specs[0].payloads).toBe(PLIST)
  })

  it('indexProfilesByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexProfilesByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.size).toBe(1)
  })

  describe('live Classic XML parsing', () => {
    it('parseProfileGeneralXml reads every general leaf including the opaque payload', () => {
      const xml =
        '<general><id>1</id><name>WiFi Profile</name><description>Corp WiFi</description>' +
        '<distribution_method>Install Automatically</distribution_method><user_removable>false</user_removable>' +
        `<level>computer</level><payloads>${PLIST.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</payloads></general>`
      const parsed = parseProfileGeneralXml(xml)
      expect(parsed.name).toBe('WiFi Profile')
      expect(parsed.description).toBe('Corp WiFi')
      expect(parsed.userRemovable).toBe(false)
      expect(parsed.level).toBe('computer')
      expect(parsed.payloads).toBe(PLIST)
    })

    it('parseProfileScopeXml reads all_computers, group names and exclusion group names', () => {
      const xml =
        '<scope><all_computers>false</all_computers>' +
        '<computer_groups><computer_group><id>1</id><name>Fleet A</name></computer_group></computer_groups>' +
        '<exclusions><computer_groups><computer_group><id>2</id><name>Fleet B</name></computer_group></computer_groups></exclusions>' +
        '</scope>'
      const parsed = parseProfileScopeXml(xml)
      expect(parsed.allComputers).toBe(false)
      expect(parsed.groupNames).toEqual(['Fleet A'])
      expect(parsed.exclusionGroupNames).toEqual(['Fleet B'])
    })
  })
})
