import { appPath, appsBasePath, installApp, readAppInspectOptions } from '../deploy'
import { buildAppPackage, extractAppSpec } from '../../../lib/splunkPackage'
import { collectBlockingChecks, evaluateGate, PRIVATE_TAG } from '../../../lib/appInspect'
import type { AcsRequestOptions } from '../../../lib/acs'

const acs: AcsRequestOptions = {
  baseUrl: 'https://admin.splunk.com',
  stack: 'acme',
  token: 'STACK_JWT',
  timeoutMs: 5_000,
}

const APPINSPECT_JWT = 'APPINSPECT_JWT'

function buildPackage() {
  const { spec } = extractAppSpec(
    {
      name: 'TA_acme',
      label: 'Acme Add-on',
      version: '1.0.0',
      author: 'Veltrix',
      description: 'Parses Acme events',
      appFiles: [{ path: 'default/props.conf', content: '[acme:json]\nKV_MODE = json\n' }],
    },
    { build: 1 },
  )
  return buildAppPackage(spec)
}

/** Capture the single request installApp makes. */
interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: Buffer
}

function captureFetch(): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Captured[] = []

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: Buffer.from(init.body as Uint8Array),
    })
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ name: 'TA_acme', status: 'installed', version: '1.0.0' }),
    }
  }) as unknown as typeof fetch

  return { calls, restore: () => { globalThis.fetch = original } }
}

describe('Splunk Cloud Apps deploy — ACS endpoints', () => {
  it('namespaces the apps collection under /victoria for Victoria only', () => {
    expect(appsBasePath('victoria')).toBe('/apps/victoria')
    expect(appsBasePath('classic')).toBe('/apps')
    expect(appPath('victoria', 'TA_acme')).toBe('/apps/victoria/TA_acme')
    expect(appPath('classic', 'TA_acme')).toBe('/apps/TA_acme')
  })
})

describe('Splunk Cloud Apps deploy — install request shape', () => {
  it('Victoria: POSTs the RAW .tar.gz bytes with the AppInspect token in X-Splunk-Authorization', async () => {
    const { calls, restore } = captureFetch()
    const pkg = buildPackage()
    try {
      await installApp(acs, 'victoria', APPINSPECT_JWT, pkg)
    } finally {
      restore()
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://admin.splunk.com/acme/adminconfig/v2/apps/victoria')
    expect(call.method).toBe('POST')
    expect(call.headers.Authorization).toBe('Bearer STACK_JWT')
    expect(call.headers['X-Splunk-Authorization']).toBe(APPINSPECT_JWT)
    // Required — ACS rejects an install without the legal acknowledgement.
    expect(call.headers['ACS-Legal-Ack']).toBe('Y')
    expect(call.headers['Content-Type']).toBe('application/octet-stream')
    // The body is the archive itself, byte for byte — not a multipart wrapper.
    expect(call.body.equals(pkg.bytes)).toBe(true)
    // gzip magic
    expect(call.body[0]).toBe(0x1f)
    expect(call.body[1]).toBe(0x8b)
  })

  it('Classic: POSTs a multipart body carrying token=<appinspect jwt> and the package', async () => {
    const { calls, restore } = captureFetch()
    const pkg = buildPackage()
    try {
      await installApp(acs, 'classic', APPINSPECT_JWT, pkg)
    } finally {
      restore()
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://admin.splunk.com/acme/adminconfig/v2/apps')
    expect(call.headers.Authorization).toBe('Bearer STACK_JWT')
    expect(call.headers['ACS-Legal-Ack']).toBe('Y')
    expect(call.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)
    // Classic carries the AppInspect token as a FORM FIELD, not a header.
    expect(call.headers['X-Splunk-Authorization']).toBeUndefined()

    const body = call.body.toString('latin1')
    expect(body).toContain('Content-Disposition: form-data; name="token"')
    expect(body).toContain(APPINSPECT_JWT)
    expect(body).toContain(`name="package"; filename="${pkg.fileName}"`)
    expect(body).toContain('Content-Type: application/octet-stream')
    // The archive bytes are embedded verbatim inside the multipart body.
    expect(call.body.includes(pkg.bytes)).toBe(true)
    expect(call.body.length).toBeGreaterThan(pkg.bytes.length)
  })
})

describe('Splunk Cloud Apps deploy — the AppInspect gate', () => {
  const clean = {
    summary: { error: 0, failure: 0, manual_check: 0, not_applicable: 3, skipped: 0, success: 42, warning: 2 },
  }

  it('allows install only when failure, error and manual_check are all zero', () => {
    const gate = evaluateGate(clean)
    expect(gate.allowed).toBe(true)
    expect(gate.reason).toBe('')
  })

  it('blocks install on a failure', () => {
    const gate = evaluateGate({
      summary: { ...clean.summary, failure: 1 },
      reports: [
        {
          groups: [
            {
              name: 'cloud',
              checks: [
                {
                  name: 'check_for_outputs_conf',
                  result: 'failure',
                  messages: [{ message: 'outputs.conf is not permitted' }],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('1 failure(s)')
    expect(gate.reason).toContain('check_for_outputs_conf')
    expect(gate.blocking).toHaveLength(1)
  })

  it('blocks install on an error', () => {
    const gate = evaluateGate({ summary: { ...clean.summary, error: 2 } })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('2 error(s)')
  })

  it('blocks install on a manual_check and says a Support case is the only route', () => {
    const gate = evaluateGate({
      summary: { ...clean.summary, manual_check: 1 },
      reports: [
        {
          groups: [
            {
              name: 'manual',
              checks: [
                {
                  name: 'check_for_binary_files',
                  result: 'manual_check',
                  messages: [{ message: 'A binary file requires manual review' }],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('1 manual check(s)')
    expect(gate.reason).toContain('Contact Splunk Support')
    expect(gate.blocking[0].result).toBe('manual_check')
  })

  it('collects every blocking check and ignores passing ones', () => {
    const blocking = collectBlockingChecks({
      reports: [
        {
          groups: [
            {
              name: 'g1',
              checks: [
                { name: 'ok', result: 'success' },
                { name: 'skip', result: 'not_applicable' },
                { name: 'bad', result: 'failure', messages: [{ message: 'nope' }] },
                { name: 'review', result: 'manual_check', description: 'needs a human' },
              ],
            },
          ],
        },
      ],
    })
    expect(blocking.map((c) => c.name)).toEqual(['bad', 'review'])
    expect(blocking[1].message).toBe('needs a human')
  })
})

describe('Splunk Cloud Apps deploy — vetting profile and settings', () => {
  it('selects the private-app tag for the target experience', () => {
    expect(PRIVATE_TAG.victoria).toBe('private_victoria')
    expect(PRIVATE_TAG.classic).toBe('private_classic')
  })

  it('reads the AppInspect wait budget from settings, with a default', () => {
    expect(readAppInspectOptions({}).maxWaitMs).toBe(900_000)
    expect(readAppInspectOptions({ appinspect_max_wait_seconds: 120 }).maxWaitMs).toBe(120_000)
    // A nonsense value must not disable the timeout.
    expect(readAppInspectOptions({ appinspect_max_wait_seconds: -5 }).maxWaitMs).toBe(900_000)
  })
})
