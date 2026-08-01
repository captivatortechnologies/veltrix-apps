import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Suspicious Object List']

/**
 * Step-by-step connection guide for Trend Vision One, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Trend Vision One console, go to <strong>Administration → API Keys</strong> and add an API
              key for a role with the right permissions (tokens expire one year after creation by default).
              This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API key as a Veltrix credential (token field) on the <strong>Connections</strong> page.
              Vision One authenticates with the key alone — no username is required.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection pointing at your regional Vision One API host
              (e.g. <code>api.xdr.trendmicro.com</code> for the US, <code>api.eu.xdr.trendmicro.com</code> for
              Europe) and attach the API token. Use <strong>Test</strong> to verify Vision One is reachable and
              the token authenticates (GET <code>/v3.0/threatintel/suspiciousObjects</code>). Saving the
              connection also registers the tenant as a deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the Vision One <strong>Suspicious
              Objects</strong> configuration type, author your objects (type, value, scan action, risk level,
              expiration), and deploy through the pipeline. Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
