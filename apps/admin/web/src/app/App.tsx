import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { Button } from '@astryxdesign/core/Button'
import { Center } from '@astryxdesign/core/Center'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { PageSpinner } from '../components/PageSpinner'
import { useDocumentTitle } from '../lib/hooks'
import LoginPage from '../pages/Login'
import { useSession } from '../lib/session'
import { Shell } from './Shell'

const OverviewPage = lazy(() => import('../pages/Overview'))
const MembersPage = lazy(() => import('../pages/Members'))
const ChannelsPage = lazy(() => import('../pages/Channels'))
const AgentsPage = lazy(() => import('../pages/Agents'))
const ServicesPage = lazy(() => import('../pages/Services'))
const LogsPage = lazy(() => import('../pages/Logs'))
const MetricsPage = lazy(() => import('../pages/Metrics'))
const AlertsPage = lazy(() => import('../pages/Alerts'))
const DeploymentsPage = lazy(() => import('../pages/Deployments'))
const SettingsPage = lazy(() => import('../pages/Settings'))
const NotFoundPage = lazy(() => import('../pages/NotFound'))

/** Renders the console for a signed-in operator and sends everyone else to sign in. */
function ProtectedShell() {
  const location = useLocation()
  const session = useSession()

  useDocumentTitle('Console')

  if (session.isPending) return <PageSpinner label="Checking your session" />

  // Only when nothing is known about the session. A failed re-check keeps the console as it is.
  if (session.isError && session.data === undefined) {
    return (
      <Center axis="both" height="100%" padding={6}>
        <EmptyState
          headingLevel={1}
          title="The console server is not responding"
          description="Your session could not be checked. The admin service may be restarting."
          actions={<Button label="Retry" variant="primary" isLoading={session.isFetching} onClick={() => session.refetch()} />}
        />
      </Center>
    )
  }

  if (!session.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <Shell session={session.data} />
}

export function App() {
  return (
    <Suspense fallback={<PageSpinner label="Loading" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="channels" element={<ChannelsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="services" element={<ServicesPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="metrics" element={<MetricsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="deployments" element={<DeploymentsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
