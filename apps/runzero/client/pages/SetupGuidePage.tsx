import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Sites']

/**
 * Step-by-step connection guide for runZero, rendered with the platform
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
              In the runZero console, go to <strong>Account → API keys</strong> and create (or reuse) an{' '}
              <strong>Organization API key</strong> (OT… prefix) for the target organization. An Organization key
              carries its org id in the token, so no organization has to be selected separately. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API key as a Veltrix credential on the <strong>Connections</strong> page. runZero
              authenticates with the key alone (Bearer) — no username is required.
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
              On <strong>Connections</strong>, add a connection for the runZero console (leave the endpoint as{' '}
              <code>console.runzero.com</code> for the hosted platform) and attach the Organization API key. Use{' '}
              <strong>Test</strong> to verify runZero is reachable and the key authenticates (GET{' '}
              <code>/org/sites</code>). Saving the connection also registers the organization as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the runZero <strong>Sites</strong>
              configuration type, author your sites (name, description, and the default scan scope as
              subnets/CIDRs), and deploy through the pipeline. Sites are upserted by name; drift detection and
              rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
