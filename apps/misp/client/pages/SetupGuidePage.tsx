import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Threat feeds']

/**
 * Step-by-step connection guide for MISP, rendered with the platform design-system
 * components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Automation key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In MISP, go to <strong>Administration → List Auth Keys</strong> and create (or reuse) an
              automation key for a user with the right permissions. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the automation key as a Veltrix credential on the <strong>Connections</strong> page. MISP
              authenticates with the key alone — no username is required.
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
              On <strong>Connections</strong>, add a connection pointing at your MISP host (its HTTPS address
              on 443) and attach the automation key. Use <strong>Test</strong> to verify MISP is reachable and
              the key authenticates (GET <code>/servers/getVersion</code>). Saving the connection also
              registers the MISP core as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the MISP <strong>Threat Feeds</strong>
              configuration type, author your feeds (name, provider, URL, source format, enabled), and deploy
              through the pipeline. Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
