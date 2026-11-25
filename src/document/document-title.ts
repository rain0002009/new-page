export const DEFAULT_DOCUMENT_TITLE = '页墟 · Markdown'

/**
 * Resolve the browser tab title for a document view, falling back to the
 * default title when no non-whitespace document name is available.
 */
export function resolveDocumentTitle(title?: string): string {
  return title?.trim() || DEFAULT_DOCUMENT_TITLE
}

/**
 * Extract the decoded leaf filename from a document URL, or an empty string
 * when the URL is invalid or points to a directory path.
 */
export function urlFilename(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname.split('/').pop() || '')
  } catch {
    return ''
  }
}
