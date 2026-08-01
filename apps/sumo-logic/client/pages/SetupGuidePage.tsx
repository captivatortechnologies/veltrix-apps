import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Field Extraction Rules']

/**
 * Step-by-step connection guide for Sumo Logic, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Access Key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Sumo Logic, go to <strong>Manage → Security → Access Keys</strong> and create a new access
              key for a user (or service account) with the <strong>Manage Field Extraction Rules</strong> role
              capability. Copy the <strong>Access Key</strong> immediately — it is shown only once. This app
              manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the <strong>Access ID</strong> and <strong>Access Key</strong> as a Veltrix credential on
              the <strong>Connections</strong> page.
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
              On <strong>Connections</strong>, add a connection pointing at your Sumo Logic deployment endpoint
              (e.g. <code>api.us2.sumologic.com</code> — US1 is <code>api.sumologic.com</code>) and attach the
              Access ID / Access Key. Use <strong>Test</strong> to verify Sumo Logic is reachable and the key
              authenticates (GET <code>/api/v1/extractionRules</code>). Saving the connection also registers the
              Sumo Logic org as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Sumo Logic{' '}
              <strong>Field Extraction Rules</strong> configuration type, author your rules (name, scope, parse
              expression, enabled), and deploy through the pipeline. Drift detection and rollback are handled
              per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
