import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Case templates']

/**
 * Step-by-step connection guide for TheHive, rendered with the platform
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
              In TheHive, open your <strong>user profile → API keys</strong> and create (or reuse) an
              API key for an account with organisation-admin rights (case templates are an
              organisation-level setting). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API key as a Veltrix credential on the <strong>Connections</strong> page.
              TheHive authenticates with the key alone (sent as a <code>Bearer</code> token) — no
              username is required.
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
              On <strong>Connections</strong>, add a connection pointing at your TheHive URL (443
              behind a proxy, or <code>:9000</code> direct) and attach the API key. Use{' '}
              <strong>Test</strong> to verify TheHive is reachable and the key authenticates (GET{' '}
              <code>/api/v1/user/current</code>). Saving the connection also registers the TheHive
              instance as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the TheHive{' '}
              <strong>Case Templates</strong> configuration type, author your templates (name, display
              name, title prefix, severity, TLP/PAP, tags, description, tasks), and deploy through the
              pipeline. Templates upsert by name; drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
