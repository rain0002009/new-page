export type EpubDropMode = 'ask' | 'local' | 'quark'
export type EpubFontWeight = 400 | 500 | 600 | 700
export type EpubColumnsMode = 'single' | 'double'
export type EpubReaderSettings = {
  fontSize: number
  fontWeight: EpubFontWeight
  lineHeight: number
  columns: EpubColumnsMode
  pageAnimation: boolean
}

export const defaultEpubDropMode: EpubDropMode = 'ask'
export const defaultEpubReaderSettings: EpubReaderSettings = {
  fontSize: 18,
  fontWeight: 400,
  lineHeight: 1.75,
  columns: 'single',
  pageAnimation: true,
}

const dropModeKey = 'epubDropMode'
const readerSettingsKey = 'epubReaderSettings'
const tocExpandedKey = 'epubTocExpanded'

export function normalizeEpubDropMode(value: unknown): EpubDropMode {
  return value === 'local' || value === 'quark' || value === 'ask' ? value : defaultEpubDropMode
}

export function normalizeEpubReaderSettings(value: unknown): EpubReaderSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<EpubReaderSettings>
  const fontSize = typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)
    ? Math.max(14, Math.min(28, Math.round(raw.fontSize)))
    : defaultEpubReaderSettings.fontSize
  const fontWeight = raw.fontWeight === 400 || raw.fontWeight === 500 || raw.fontWeight === 600 || raw.fontWeight === 700
    ? raw.fontWeight
    : defaultEpubReaderSettings.fontWeight
  const lineHeight = typeof raw.lineHeight === 'number' && Number.isFinite(raw.lineHeight)
    ? Math.max(1.4, Math.min(2.2, Math.round(raw.lineHeight * 100) / 100))
    : defaultEpubReaderSettings.lineHeight
  const columns: EpubColumnsMode = raw.columns === 'double' || raw.columns === 'single'
    ? raw.columns
    : defaultEpubReaderSettings.columns
  const pageAnimation = typeof raw.pageAnimation === 'boolean'
    ? raw.pageAnimation
    : defaultEpubReaderSettings.pageAnimation
  return { fontSize, fontWeight, lineHeight, columns, pageAnimation }
}

export async function readEpubDropMode(): Promise<EpubDropMode> {
  const stored = await chrome.storage.local.get(dropModeKey)
  return normalizeEpubDropMode(stored[dropModeKey])
}

export async function saveEpubDropMode(mode: EpubDropMode): Promise<void> {
  await chrome.storage.local.set({ [dropModeKey]: mode })
}

export async function readEpubReaderSettings(): Promise<EpubReaderSettings> {
  const stored = await chrome.storage.local.get(readerSettingsKey)
  return normalizeEpubReaderSettings(stored[readerSettingsKey])
}

export async function saveEpubReaderSettings(settings: EpubReaderSettings): Promise<EpubReaderSettings> {
  const normalized = normalizeEpubReaderSettings(settings)
  await chrome.storage.local.set({ [readerSettingsKey]: normalized })
  return normalized
}

export async function readEpubExpandedTocIds(bookId: string): Promise<string[]> {
  if (!bookId) return []
  const stored = await chrome.storage.local.get(tocExpandedKey)
  const map = stored[tocExpandedKey]
  if (!map || typeof map !== 'object') return []
  const list = (map as Record<string, unknown>)[bookId]
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

export async function saveEpubExpandedTocIds(bookId: string, ids: string[]): Promise<void> {
  if (!bookId) return
  const stored = await chrome.storage.local.get(tocExpandedKey)
  const previous = (stored[tocExpandedKey] && typeof stored[tocExpandedKey] === 'object' ? stored[tocExpandedKey] : {}) as Record<string, string[]>
  await chrome.storage.local.set({
    [tocExpandedKey]: { ...previous, [bookId]: [...new Set(ids)] },
  })
}
