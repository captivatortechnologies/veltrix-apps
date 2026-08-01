import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card the built-in
 * platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'key',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the PagerDuty web app, go to <strong>Integrations &gt; API Access Keys</strong> and
              create a <strong>REST API key</strong>. A read/write key is required to create and edit
              escalation policies (a read-only key can only run health checks and drift detection).
            </p>
            <p>
              Keys are account-scoped. Prefer a dedicated key for Veltrix so it can be rotated or
              revoked independently.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API key</strong> → the PagerDuty REST API key
              </li>
            </ul>
            <p>
              The app sends it as <code>Authorization: Token token=&lt;key&gt;</code> with{' '}
              <code>Accept: application/vnd.pagerduty+json;version=2</code> to{' '}
              <code>https://api.pagerduty.com</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>pagerduty-account</strong> component for your PagerDuty account and
              attach the credential. The REST API base is fixed at{' '}
              <code>https://api.pagerduty.com</code>, so no host resolution is needed — the endpoint is
              only a human-readable label (e.g. your account subdomain).
            </p>
            <p>
              Then author an <strong>Escalation Policies</strong> configuration in the Configuration
              Canvas: give each policy a name, an optional loop count, and its escalation rules (delay
              plus user / schedule targets). Deploy it through the pipeline.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
