import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'

interface ByolInfrastructure {
  id: string
  name?: string
  status?: string
  cloud_provider?: string
  hosting_type?: string
}

/**
 * Lists the customer's BYOL Splunk infrastructure from the app API.
 */
export default function BYOLPage() {
  const [infrastructure, setInfrastructure] = useState<ByolInfrastructure[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/splunk-enterprise/byol')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setInfrastructure)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading BYOL infrastructure…</p>
  if (error) return <p role="alert">Failed to load BYOL infrastructure: {error}</p>
  if (infrastructure.length === 0) {
    return <p>No BYOL infrastructure provisioned yet.</p>
  }

  return (
    <div>
      <h2>BYOL Splunk Infrastructure</h2>
      <ul>
        {infrastructure.map((infra) => (
          <li key={infra.id}>
            <strong>{infra.name ?? infra.id}</strong>
            {infra.cloud_provider ? ` — ${infra.cloud_provider}` : null}
            {infra.status ? ` (${infra.status})` : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
