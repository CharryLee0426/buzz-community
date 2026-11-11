import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InternationalizationProvider } from '@astryxdesign/core/i18n'
import { LinkProvider } from '@astryxdesign/core/Link'
import { Theme } from '@astryxdesign/core/theme'
import './styles/globals.css'
import { App } from './app/App'
import { RouterLink } from './app/RouterLink'
import { defaultThemeSlug, themes } from './astryx-themes'
import { setCsrfToken } from './lib/api'
import { isRetryable, isSignedOut } from './lib/errors'
import { SESSION_KEY } from './lib/session'

// The session can end under an open tab: it expires, or the operator signs out
// elsewhere. Whichever request finds out marks the session as over, and the
// app shell sends the operator to sign in and back to where they were.
const onSessionEnded = (error: unknown) => {
  if (!isSignedOut(error)) return
  setCsrfToken(undefined)
  queryClient.setQueryData(SESSION_KEY, null)
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onSessionEnded }),
  mutationCache: new MutationCache({ onError: onSessionEnded }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => isRetryable(error) && failureCount < 2,
    },
  },
})

const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Day-first dates and a 24-hour clock, the same as the log and chart times this app formats itself. */}
    <InternationalizationProvider locale="en-GB">
      <Theme theme={themes[defaultThemeSlug]} mode="system">
        <QueryClientProvider client={queryClient}>
          <BrowserRouter basename={basename}>
            <LinkProvider component={RouterLink}>
              <App />
            </LinkProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </Theme>
    </InternationalizationProvider>
  </StrictMode>,
)
