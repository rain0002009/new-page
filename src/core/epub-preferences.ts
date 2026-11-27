export type EpubDropMode = 'ask' | 'local' | 'quark'
export type EpubFontWeight = 400 | 500 | 600 | 700
export type EpubReaderSettings = {
  fontSize: number
  fontWeight: EpubFontWeight
  lineHeight: number
}

export const defaultEpubDropMode: EpubDropMode = 'ask'
export const defaultEpubReaderSettings: EpubReaderSettings = {
  fontSize: 18,
  fontWeight: 400,
  lineHeight: 1.75,
}

const dropModeKey = 'epubDropMode'
const readerSettingsKey = 'epubReaderSettings'

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
  return { fontSize, fontWeight, lineHeight }
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
