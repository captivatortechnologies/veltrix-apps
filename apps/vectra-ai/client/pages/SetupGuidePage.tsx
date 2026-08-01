import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Triage rules']

/**
 * Step-by-step connection guide for Vectra AI, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Vectra, sign in with a <strong>local account</strong>, open <strong>My Profile</strong> and
              create an <strong>API Token</strong> (only local accounts can mint tokens; the token inherits
              that account's permissions). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the token as a Veltrix credential on the <strong>Connections</strong> page. Vectra
              authenticates with the token alone — sent as <code>Authorization: Token &lt;token&gt;</code>, no
              username required.
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
              On <strong>Connections</strong>, add a connection pointing at your Vectra brain (its HTTPS
              address on 443, e.g. <code>mytenant.vectra.ai</code>) and attach the API token. Use{' '}
              <strong>Test</strong> to verify Vectra is reachable and the token authenticates (GET{' '}
              <code>/api/v2.5/rules</code>). Saving the connection also registers the Vectra brain as a deploy
              target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Vectra <strong>Triage Rules</strong>
              configuration type, author your rules (description, detection category and type, whitelist or
              triage category, host/network scope), and deploy through the pipeline. Drift detection and
              rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
