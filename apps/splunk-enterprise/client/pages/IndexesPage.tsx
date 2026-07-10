import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'

interface IndexConfig {
  id: string
  name: string
  status?: string
  updatedAt?: string
}

/**
 * Lists the customer's Splunk index configurations from the app API.
 * Authoring/editing happens in the platform's Configuration Canvas.
 */
export default function IndexesPage() {
  const [configs, setConfigs] = useState<IndexConfig[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/splunk-enterprise/indexes')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setConfigs)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading index configurations…</p>
  if (error) return <p role="alert">Failed to load index configurations: {error}</p>
  if (configs.length === 0) {
    return <p>No index configurations yet. Create one from the Configuration Canvas.</p>
  }

  return (
    <div>
      <h2>Splunk Index Configurations</h2>
      <ul>
        {configs.map((config) => (
          <li key={config.id}>
            <strong>{config.name}</strong>
            {config.status ? ` — ${config.status}` : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
