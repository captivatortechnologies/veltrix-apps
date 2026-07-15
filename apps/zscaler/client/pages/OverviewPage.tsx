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
 * Shows what this app manages across ZIA and ZPA, using the platform
 * design-system components from @veltrixsecops/app-sdk/ui — so the page matches
 * the platform look and picks up the app's brand color. Authoring happens in the
 * platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/zscaler/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading Zscaler app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  const zia = meta.configurationTypes.filter((ct) => ct.id.startsWith('zia-'))
  const zpa = meta.configurationTypes.filter((ct) => ct.id.startsWith('zpa-'))

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
          Manages Zscaler configuration as code through the Zscaler OneAPI. Create a configuration in
          the Configuration Canvas and deploy it through the pipeline — validate, deploy, health
          check, drift detection and rollback are all handled per configuration type. ZIA changes are
          staged and activated as a batch; ZPA changes apply immediately.
        </p>
        {section('Zscaler Internet Access (ZIA)', zia)}
        {section('Zscaler Private Access (ZPA)', zpa)}
      </CardBody>
    </Card>
  )
}
