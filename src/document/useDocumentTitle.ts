import { useEffect } from 'react'
import { resolveDocumentTitle } from './document-title'

/**
 * Synchronize the Chrome tab title (`document.title`) with the active
 * document name, falling back to the default title when unavailable or blank.
 */
export function useDocumentTitle(title?: string) {
  const resolved = resolveDocumentTitle(title)
  useEffect(() => {
    document.title = resolved
  }, [resolved])
}
