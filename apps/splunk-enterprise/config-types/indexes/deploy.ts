import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'

/**
 * Deploy index configuration to a Splunk component.
 * Uses the Splunk REST API to create/update indexes on the target.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'No credential provided for Splunk deployment' }
  }
  if (!connectivity) {
    return { success: false, message: 'No connectivity established to Splunk component' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  const rollbackSnapshot: Record<string, unknown>[] = []
  const deployedIndexes: string[] = []

  try {
    for (const section of canvas.sections) {
      const indexName = section.fields.name as string
      const fields = section.fields

      // Capture current state for rollback
      const existing = await getExistingIndex(baseUrl, auth, indexName)
      if (existing) {
        rollbackSnapshot.push({ name: indexName, ...existing })
      }

      // Build Splunk REST API payload
      const payload: Record<string, string> = {
        name: indexName,
      }
      if (fields.maxDataSizeMB) payload.maxDataSize = `${fields.maxDataSizeMB}`
      if (fields.frozenTimeDays) payload.frozenTimePeriodInSecs = `${(fields.frozenTimeDays as number) * 86400}`
      if (fields.homePath) payload.homePath = fields.homePath as string
      if (fields.coldPath) payload.coldPath = fields.coldPath as string
      if (fields.thawedPath) payload.thawedPath = fields.thawedPath as string

      if (existing) {
        // Update existing index
        await splunkRequest(`${baseUrl}/services/data/indexes/${indexName}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(payload).toString(),
        })
      } else {
        // Create new index
        await splunkRequest(`${baseUrl}/services/data/indexes`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(payload).toString(),
        })
      }

      deployedIndexes.push(indexName)
    }

    return {
      success: true,
      message: `Deployed ${deployedIndexes.length} index(es): ${deployedIndexes.join(', ')}`,
      artifacts: { deployedIndexes },
      rollbackData: { previousState: rollbackSnapshot },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deployment failed after ${deployedIndexes.length} index(es): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { deployedIndexes, failedAt: canvas.sections[deployedIndexes.length]?.fields?.name },
    }
  }
}

// --- Helpers ---

function buildSplunkUrl(
  component: DeployContext['component'],
  connectivity: NonNullable<DeployContext['connectivity']>,
): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<DeployContext['credential']>): Record<string, string> {
  if (credential.apiToken) {
    return { Authorization: `Bearer ${credential.apiToken}` }
  }
  const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

async function getExistingIndex(
  baseUrl: string,
  auth: Record<string, string>,
  indexName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await splunkRequest(
      `${baseUrl}/services/data/indexes/${indexName}?output_mode=json`,
      { method: 'GET', headers: auth },
    )
    const data = JSON.parse(res)
    return data?.entry?.[0]?.content || null
  } catch {
    return null
  }
}

async function splunkRequest(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<string> {
  // Use Node's native fetch (Node 18+)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  try {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      // Skip TLS verification for self-signed Splunk certs in non-prod
      // @ts-ignore
      ...(process.env.NODE_ENV !== 'production' && { rejectUnauthorized: false }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Splunk API ${res.status}: ${text}`)
    }

    return await res.text()
  } finally {
    clearTimeout(timeout)
  }
}
