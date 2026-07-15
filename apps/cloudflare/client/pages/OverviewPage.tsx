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
 * Shows what this app manages in a Cloudflare zone/account, using the platform
 * design-system components from @veltrixsecops/app-sdk/ui — so the page matches
 * the platform look and picks up the app's brand color. Authoring happens in the
 * platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/cloudflare/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Cloudflare app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  const zone = meta.configurationTypes.filter(
    (ct) => !ct.id.includes('access') && !ct.id.includes('gateway') && ct.id !== 'cloudflare-lists',
  )
  const account = meta.configurationTypes.filter(
    (ct) => ct.id.includes('access') || ct.id.includes('gateway') || ct.id === 'cloudflare-lists',
  )

  const section = (title: string, items: ConfigTypeSummary[]) =>
    items.length === 0 ? null : (
      <>
        <h3>{title}</h3>
        {items.map((ct) => (
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
      </>
    )

  return (
    <Card>
      <CardBody>
        <p>
          Manages Cloudflare configuration as code through the Cloudflare API. Create a configuration
          in the Configuration Canvas and deploy it through the pipeline — validate, deploy, health
          check, drift detection and rollback are all handled per configuration type. The component
          hostname is the zone domain; zone and account ids are resolved automatically.
        </p>
        {section('Zone configuration', zone)}
        {section('Account & Zero Trust configuration', account)}
      </CardBody>
    </Card>
  )
}
