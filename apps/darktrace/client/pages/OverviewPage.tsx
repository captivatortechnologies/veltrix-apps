import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { Badge, Card, CardBody, EmptyState, Spinner } from '@veltrixsecops/app-sdk/ui'

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
 * What this app manages in a Darktrace deployment, rendered with the platform
 * design-system components. Authoring happens in the Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/darktrace/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Darktrace app details…" />
  if (error) return <EmptyState title="Failed to load app details" description={error} />
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <Card>
      <CardBody>
        <p>
          Manages a Darktrace NDR deployment's <strong>intel feed</strong> as code. Author watched
          domains, IPs and hostnames in the Configuration Canvas and deploy them through the pipeline —
          validate, deploy, health check, drift detection and rollback are handled per configuration type.
          Entries are applied over the Darktrace REST API (HTTPS 443, DSA-signed, self-signed tolerated).
        </p>
        <p>
          Darktrace's API is <strong>read-heavy</strong> — most endpoints report on models, breaches and
          devices. The intel feed (<code>/intelfeed</code>) is its primary writable surface, so this app
          manages exactly that: the watched-domain list that feeds Darktrace's detections.
        </p>

        <h3>Configuration Types</h3>
        {meta.configurationTypes.map((ct) => (
          <Card key={ct.id} variant="bordered" padding="md">
            <CardBody>
              <strong>{ct.name}</strong>
              {ct.description ? <p>{ct.description}</p> : null}
              <div>
                {ct.componentTypes.map((type) => (
                  <Badge key={type} variant="secondary" size="sm">
                    {type}
                  </Badge>
                ))}
              </div>
            </CardBody>
          </Card>
        ))}
      </CardBody>
    </Card>
  )
}
