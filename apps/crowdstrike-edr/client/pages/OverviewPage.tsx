import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'

interface ConfigTypeSummary {
  id: string
  name: string
  description?: string
  componentTypes: string[]
}

interface AppMeta {
  appId: string
  name: string
  version: string
  configurationTypes: ConfigTypeSummary[]
}

/**
 * Shows what this app manages in a CrowdStrike Falcon tenant.
 * Authoring/editing happens in the platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // App routes are bearer-token protected — authFetch attaches the header
    authFetch('/api/apps/crowdstrike-edr/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading CrowdStrike Falcon app details…</p>
  if (error) return <p role="alert">Failed to load app details: {error}</p>
  if (!meta) return <p>No app details available.</p>

  return (
    <div>
      <h2>
        {meta.name} <small>v{meta.version}</small>
      </h2>
      <p>
        Manages CrowdStrike Falcon configuration as code through the Falcon APIs. Create a
        configuration in the Configuration Canvas and deploy it through the pipeline — validate,
        deploy, health check, drift detection, and rollback are all handled per configuration
        type.
      </p>
      <h3>Configuration Types</h3>
      <ul>
        {meta.configurationTypes.map((ct) => (
          <li key={ct.id}>
            <strong>{ct.name}</strong>
            {ct.description ? <> — {ct.description}</> : null}
            <br />
            <small>Targets: {ct.componentTypes.join(', ')}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}
