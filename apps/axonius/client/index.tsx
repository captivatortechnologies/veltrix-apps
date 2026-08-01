import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'axonius',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/axonius/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/axonius/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/axonius/connections', label: 'Connections', icon: 'link' },
  ],
}
