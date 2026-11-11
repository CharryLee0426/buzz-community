import { useCallback, useEffect } from 'react'
import { useToast } from '@astryxdesign/core/Toast'

const SITE = 'Buzz Community'

/** Names the browser tab after the screen in it. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${SITE}`
  }, [title])
}

/**
 * Copies a value and says so. `what` names it for the confirmation, as in
 * "Public key copied". Resolves false when the browser refused, after saying
 * that too, so a caller can offer the value another way.
 */
export function useCopy() {
  const showToast = useToast()
  return useCallback(
    async (value: string, what: string) => {
      try {
        await navigator.clipboard.writeText(value)
        showToast({ body: `${what} copied` })
        return true
      } catch {
        showToast({ body: 'The browser blocked copying.', type: 'error' })
        return false
      }
    },
    [showToast],
  )
}
