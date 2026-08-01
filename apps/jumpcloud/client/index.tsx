import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'jumpcloud',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/jumpcloud/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/jumpcloud/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/jumpcloud/connections', label: 'Connections', icon: 'link' },
  ],
}
