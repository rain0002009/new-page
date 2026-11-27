import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, ListTree, PanelLeftClose, PanelLeftOpen, SlidersHorizontal } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { computeReadingProgress, parseEpub, type EpubTocItem, type ParsedEpub } from '../core/epub'
import { defaultEpubReaderSettings, readEpubExpandedTocIds, readEpubReaderSettings, saveEpubExpandedTocIds, saveEpubReaderSettings, type EpubColumnsMode, type EpubFontWeight, type EpubReaderSettings } from '../core/epub-preferences'
import { getBookBytes } from '../core/epub-storage'
import { readLocalSnapshot, storageKey } from '../core/local-workspace'
import { isActive, type Book } from '../core/model'
import { rpc } from '../core/protocol'
import { Button, Tooltip } from '../newtab/ui'
import Switch from '../newtab/Switch'
import { Toast } from '../shared/Toast'
import { useDocumentTitle } from '../document/useDocumentTitle'
import { renderChapterHtml } from './chapter-renderer'

const readerStyles = tv({
  slots: {
    shell: 'h-dvh w-full overflow-hidden flex bg-ui-canvas text-ui-text [@media(max-width:850px)]:flex-col',
    sidebar: 'w-[300px] shrink-0 h-full flex flex-col gap-[14px] p-[16px] border-r border-r-solid border-ui-line bg-[#f2f5ea] overflow-hidden [@media(max-width:850px)]:w-full [@media(max-width:850px)]:h-auto [@media(max-width:850px)]:max-h-[42dvh] [@media(max-width:850px)]:border-r-0 [@media(max-width:850px)]:border-b [@media(max-width:850px)]:border-b-solid [@media(max-width:850px)]:border-ui-line',
    panel: 'rounded-[14px] bg-ui-surface border border-solid border-white p-[14px] shadow-[0_4px_18px_#4c683408]',
    panelTitle: 'flex items-center gap-[7px] text-[13px] font-semibold text-[#384730] mb-[10px]',
    main: 'flex-1 min-w-0 h-full flex flex-col overflow-hidden px-[24px] py-[16px] gap-[12px] [@media(max-width:650px)]:px-[12px] [@media(max-width:650px)]:py-[10px]',
    header: 'shrink-0 flex items-center justify-between gap-[12px] min-h-[34px]',
    paper: 'flex-1 min-h-0 flex flex-col rounded-[20px] bg-ui-surface border border-solid border-white px-[36px] py-[28px] shadow-[0_10px_35px_#4c68340a] overflow-hidden [@media(max-width:650px)]:px-[18px] [@media(max-width:650px)]:py-[18px]',
    viewport: 'flex-1 min-h-0 w-full overflow-hidden relative',
    content: 'text-[#2f392a] [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:max-h-[var(--reader-page-h)] [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain [&_img]:mx-auto [&_img]:my-[12px] [&_img]:block [&_img]:rounded-[8px] [&_img]:break-inside-avoid [&_svg]:max-w-full [&_svg]:max-h-[var(--reader-page-h)] [&_svg]:h-auto [&_h1]:text-[1.5em] [&_h1]:leading-[1.35] [&_h1]:mt-[0.2em] [&_h1]:mb-[0.65em] [&_h1]:break-after-avoid [&_h2]:text-[1.3em] [&_h2]:leading-[1.4] [&_h2]:mt-[0.9em] [&_h2]:mb-[0.5em] [&_h2]:break-after-avoid [&_h3]:text-[1.12em] [&_h3]:mt-[0.8em] [&_h3]:mb-[0.4em] [&_h3]:break-after-avoid [&_p]:my-[0.65em] [&_blockquote]:border-l-[3px] [&_blockquote]:border-l-solid [&_blockquote]:border-[#b2c495] [&_blockquote]:pl-[14px] [&_blockquote]:text-[#5a6652] [&_blockquote]:break-inside-avoid [&_a]:text-[#4e7238] [&_a]:underline [&_pre]:overflow-hidden [&_pre]:rounded-[10px] [&_pre]:bg-[#f2f5eb] [&_pre]:p-[10px] [&_pre]:break-inside-avoid',
    footer: 'shrink-0 flex items-center justify-between gap-[12px]',
  },
})()

const optionButton = tv({
  base: 'py-[5px] px-[4px] rounded-[7px] text-[11px] border border-solid cursor-pointer transition-colors',
  variants: {
    selected: {
      true: 'bg-[#4c6b85] text-white border-[#4c6b85] font-semibold',
      false: 'bg-[#f7f8f2] text-ui-ink border-form-line hover:bg-[#edf2f6]',
    },
  },
})

const tocButton = tv({
  base: 'flex-1 min-w-0 text-left border-0 rounded-[7px] px-[7px] py-[5px] text-[12px] leading-[1.45] cursor-pointer transition-colors [overflow-wrap:anywhere]',
  variants: {
    active: {
      true: 'bg-[#e4ecf2] text-[#2e485d] font-semibold',
      false: 'bg-transparent text-ui-sage hover:bg-[#f2f5eb] hover:text-ui-ink',
    },
  },
})

const fontWeights: { value: EpubFontWeight; label: string }[] = [
  { value: 400, label: '常规' },
  { value: 500, label: '中等' },
  { value: 600, label: '半粗' },
  { value: 700, label: '粗体' },
]

const columnOptions: { value: EpubColumnsMode; label: string }[] = [
  { value: 'single', label: '单栏' },
  { value: 'double', label: '双栏' },
]

function findFirstTocIdForChapter(items: EpubTocItem[], chapterIndex: number): string | undefined {
  for (const item of items) {
    if (item.chapterIndex === chapterIndex) return item.id
    const nested = findFirstTocIdForChapter(item.children, chapterIndex)
    if (nested) return nested
  }
  return undefined
}

export default function ReaderApp() {
  const params = new URLSearchParams(location.search)
  const bookId = params.get('book') ?? ''
  const sourceId = params.get('source') ?? ''

  const [book, setBook] = useState<Book | null>(null)
  const [parsed, setParsed] = useState<ParsedEpub | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [chapterIndex, setChapterIndex] = useState(0)
  const [pageIndex, setPageIndex] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [animateTurn, setAnimateTurn] = useState(false)
  const [activeTocId, setActiveTocId] = useState<string | undefined>(undefined)
  const [expandedTocIds, setExpandedTocIds] = useState<Set<string>>(() => new Set())
  const [progress, setProgress] = useState(0)
  const [settings, setSettings] = useState<EpubReaderSettings>(defaultEpubReaderSettings)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const flowingRef = useRef<HTMLDivElement | null>(null)
  const pendingFragment = useRef<string | undefined>(undefined)
  const pendingLastPage = useRef(false)
  const initialRestoreRatio = useRef<number | null>(null)
  const preserveRatioOnLayout = useRef<number | null>(null)
  const navLockRef = useRef(0)
  const saveTimer = useRef<number | undefined>(undefined)
  const availableRef = useRef(true)
  const latestPosition = useRef<{ chapterIndex: number; scrollRatio: number; progress: number }>({
    chapterIndex: 0,
    scrollRatio: 0,
    progress: 0,
  })
  const [jumpSeq, setJumpSeq] = useState(0)

  availableRef.current = available

  useDocumentTitle(book?.title ?? parsed?.title)

  const persistProgress = useCallback(async (nextChapter: number, nextRatio: number, nextProgress: number) => {
    if (!availableRef.current || !bookId || !sourceId) return
    try {
      await rpc({
        type: 'action',
        sourceId,
        action: {
          type: 'edit',
          id: bookId,
          patch: {
            chapterIndex: nextChapter,
            scrollRatio: nextRatio,
            progress: nextProgress,
          },
        },
      })
    } catch {
      /* Preserve reader UI even if background save temporarily fails. */
    }
  }, [bookId, sourceId])

  const scheduleSave = useCallback((nextChapter: number, nextRatio: number, nextProgress: number) => {
    latestPosition.current = { chapterIndex: nextChapter, scrollRatio: nextRatio, progress: nextProgress }
    setProgress(nextProgress)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined
      void persistProgress(nextChapter, nextRatio, nextProgress)
    }, 300)
  }, [persistProgress])

  useEffect(() => {
    void readEpubReaderSettings().then(setSettings)
  }, [])

  useEffect(() => {
    let disposed = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        if (!bookId || !sourceId) throw new Error('缺少电子书参数，请从收藏块重新打开')
        const snapshot = await readLocalSnapshot()
        if (disposed) return
        if (snapshot.sourceId !== sourceId) throw new Error('收藏库已切换，请返回当前收藏库打开电子书')
        const entity = snapshot.document?.entities[bookId]
        if (entity?.kind !== 'book' || !isActive(snapshot.document!, entity)) {
          throw new Error(entity?.purged ? '电子书已永久删除' : '电子书已删除或移入回收站')
        }
        setBook(entity)

        let bytes = await getBookBytes(entity.id)
        if (!bytes) {
          if (entity.storage === 'quark' && entity.quarkFid) {
            await rpc({ type: 'download-book-quark', sourceId, bookId: entity.id })
            bytes = await getBookBytes(entity.id)
          } else {
            throw new Error('该电子书仅保存在原设备本地，当前设备无法读取')
          }
        }
        if (!bytes) throw new Error('无法读取电子书文件内容，请重试')

        const epub = parseEpub(bytes, entity.fileName)
        const savedExpanded = await readEpubExpandedTocIds(entity.id)
        if (disposed) return
        const restoredChapter = Math.max(0, Math.min(epub.chapters.length - 1, entity.chapterIndex))
        initialRestoreRatio.current = entity.scrollRatio
        latestPosition.current = {
          chapterIndex: restoredChapter,
          scrollRatio: entity.scrollRatio,
          progress: entity.progress,
        }
        setParsed(epub)
        setExpandedTocIds(new Set(savedExpanded))
        setActiveTocId(findFirstTocIdForChapter(epub.toc, restoredChapter))
        setChapterIndex(restoredChapter)
        setProgress(entity.progress)
        setAvailable(true)
      } catch (cause) {
        if (!disposed) {
          setAvailable(false)
          setError(cause instanceof Error ? cause.message : '打开电子书失败，请重试')
        }
      } finally {
        if (!disposed) setLoading(false)
      }
    }
    void load()

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[storageKey]) return
      void readLocalSnapshot().then(snapshot => {
        if (disposed) return
        const entity = snapshot.sourceId === sourceId ? snapshot.document?.entities[bookId] : undefined
        if (entity?.kind !== 'book' || !isActive(snapshot.document!, entity)) {
          setAvailable(false)
          setError(entity?.purged ? '电子书已被删除' : '电子书已不可用')
        } else {
          setBook(entity)
        }
      })
    }
    chrome.storage.onChanged.addListener(onChanged)

    const flush = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = undefined
        const pos = latestPosition.current
        void persistProgress(pos.chapterIndex, pos.scrollRatio, pos.progress)
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      disposed = true
      chrome.storage.onChanged.removeListener(onChanged)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [bookId, sourceId, persistProgress])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const measure = () => {
      const width = Math.floor(node.clientWidth)
      const height = Math.floor(node.clientHeight)
      if (width > 0 && height > 0) {
        setAnimateTurn(false)
        setViewportSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [loading, available, sidebarOpen])

  const currentChapter = parsed?.chapters[chapterIndex]
  const rendered = useMemo(() => {
    if (!parsed || !currentChapter) return { html: '', objectUrls: [] as string[] }
    return renderChapterHtml(parsed, currentChapter.href)
  }, [parsed, currentChapter])

  useEffect(() => {
    return () => {
      for (const url of rendered.objectUrls) URL.revokeObjectURL(url)
    }
  }, [rendered])

  const colsPerPage = settings.columns === 'double' && viewportSize.width >= 720 ? 2 : 1
  const colGap = colsPerPage === 2 ? 48 : 32
  const colWidth = viewportSize.width > 0
    ? Math.max(200, colsPerPage === 2 ? Math.floor((viewportSize.width - colGap) / 2) : viewportSize.width)
    : 600
  const pageStride = colsPerPage * (colWidth + colGap)

  const syncPageState = useCallback((nextPage: number, nextTotalPages: number) => {
    if (!parsed) return
    const clampedPage = Math.max(0, Math.min(nextTotalPages - 1, nextPage))
    setPageIndex(clampedPage)
    const ratio = nextTotalPages <= 1 ? 1 : clampedPage / (nextTotalPages - 1)
    const nextProgress = computeReadingProgress(parsed.chapters, chapterIndex, ratio)
    scheduleSave(chapterIndex, ratio, nextProgress)
  }, [parsed, chapterIndex, scheduleSave])

  useLayoutEffect(() => {
    const el = flowingRef.current
    if (!el || !parsed || !available || viewportSize.width <= 0 || viewportSize.height <= 0) return

    const measurePages = () => {
      const totalColumns = Math.max(1, Math.round((el.scrollWidth + colGap) / (colWidth + colGap)))
      const pages = Math.max(1, Math.ceil(totalColumns / colsPerPage))
      setTotalPages(pages)

      const fragment = pendingFragment.current
      pendingFragment.current = undefined
      if (fragment) {
        const target = el.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`)
          ?? el.querySelector<HTMLElement>(`[name="${CSS.escape(fragment)}"]`)
        if (target) {
          const offsetX = target.getBoundingClientRect().left - el.getBoundingClientRect().left
          const colIndex = Math.max(0, Math.floor((offsetX + 4) / (colWidth + colGap)))
          const targetPage = Math.min(pages - 1, Math.floor(colIndex / colsPerPage))
          syncPageState(targetPage, pages)
          return
        }
      }

      if (pendingLastPage.current) {
        pendingLastPage.current = false
        syncPageState(pages - 1, pages)
        return
      }

      if (initialRestoreRatio.current !== null) {
        const ratio = initialRestoreRatio.current
        initialRestoreRatio.current = null
        const targetPage = pages <= 1 ? 0 : Math.min(pages - 1, Math.round(ratio * (pages - 1)))
        setPageIndex(targetPage)
        if (pages <= 1) {
          scheduleSave(chapterIndex, 1, computeReadingProgress(parsed.chapters, chapterIndex, 1))
        }
        return
      }

      if (preserveRatioOnLayout.current !== null) {
        const ratio = preserveRatioOnLayout.current
        preserveRatioOnLayout.current = null
        const targetPage = pages <= 1 ? 0 : Math.min(pages - 1, Math.round(ratio * (pages - 1)))
        setPageIndex(targetPage)
        return
      }

      setPageIndex(prev => {
        const clamped = Math.max(0, Math.min(pages - 1, prev))
        if (pages <= 1) {
          scheduleSave(chapterIndex, 1, computeReadingProgress(parsed.chapters, chapterIndex, 1))
        }
        return clamped
      })
    }

    const raf = requestAnimationFrame(measurePages)
    return () => cancelAnimationFrame(raf)
  }, [rendered.html, viewportSize.width, viewportSize.height, colWidth, colGap, colsPerPage, settings.columns, settings.fontSize, settings.fontWeight, settings.lineHeight, jumpSeq, parsed, available, chapterIndex, scheduleSave, syncPageState])

  const openChapter = useCallback((targetIndex: number, options?: { fragment?: string; lastPage?: boolean; tocId?: string }) => {
    if (!parsed) return
    const clamped = Math.max(0, Math.min(parsed.chapters.length - 1, targetIndex))
    pendingFragment.current = options?.fragment
    pendingLastPage.current = options?.lastPage ?? false
    initialRestoreRatio.current = null
    preserveRatioOnLayout.current = null
    setActiveTocId(options?.tocId ?? findFirstTocIdForChapter(parsed.toc, clamped))
    setAnimateTurn(false)
    if (clamped !== chapterIndex) {
      setPageIndex(0)
      setChapterIndex(clamped)
      if (!options?.fragment && !options?.lastPage) {
        scheduleSave(clamped, 0, computeReadingProgress(parsed.chapters, clamped, 0))
      }
    } else if (!options?.fragment) {
      syncPageState(options?.lastPage ? totalPages - 1 : 0, totalPages)
    }
    setJumpSeq(seq => seq + 1)
  }, [parsed, chapterIndex, totalPages, scheduleSave, syncPageState])

  const turnPage = useCallback((delta: 1 | -1) => {
    if (!parsed || !available) return
    if (delta > 0) {
      if (pageIndex < totalPages - 1) {
        setAnimateTurn(true)
        syncPageState(pageIndex + 1, totalPages)
      } else if (chapterIndex < parsed.chapters.length - 1) {
        openChapter(chapterIndex + 1)
      }
    } else {
      if (pageIndex > 0) {
        setAnimateTurn(true)
        syncPageState(pageIndex - 1, totalPages)
      } else if (chapterIndex > 0) {
        openChapter(chapterIndex - 1, { lastPage: true })
      }
    }
  }, [parsed, available, pageIndex, totalPages, chapterIndex, syncPageState, openChapter])

  useEffect(() => {
    if (!parsed || !available) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        turnPage(1)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault()
        turnPage(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [parsed, available, turnPage])

  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    if (Math.abs(event.deltaY) < 8 && Math.abs(event.deltaX) < 8) return
    const now = Date.now()
    if (now - navLockRef.current < 160) return
    navLockRef.current = now
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    turnPage(delta > 0 ? 1 : -1)
  }

  function updateSettings(patch: Partial<EpubReaderSettings>) {
    setAnimateTurn(false)
    preserveRatioOnLayout.current = totalPages <= 1 ? 0 : pageIndex / (totalPages - 1)
    const next = { ...settings, ...patch }
    setSettings(next)
    void saveEpubReaderSettings(next).then(setSettings)
  }

  function handleContentClick(event: React.MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-epub-href]')
    if (!anchor || !parsed || !currentChapter) return
    event.preventDefault()
    const rawHref = anchor.getAttribute('data-epub-href')
    if (!rawHref) return
    const resolved = parsed.resolveHref(currentChapter.href, rawHref)
    const targetChapter = parsed.chapters.findIndex(chapter => chapter.href.toLowerCase() === resolved.path.toLowerCase())
    if (targetChapter >= 0) {
      openChapter(targetChapter, { fragment: resolved.fragment })
    }
  }

  function toggleTocBranch(id: string) {
    setExpandedTocIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      if (bookId) void saveEpubExpandedTocIds(bookId, [...next])
      return next
    })
  }

  function renderTocItems(items: EpubTocItem[], depth = 0) {
    return (
      <ol className={`list-none m-0 p-0 space-y-[2px] ${depth > 0 ? 'pl-[14px]' : ''}`}>
        {items.map(item => {
          const hasChildren = item.children.length > 0
          const isExpanded = expandedTocIds.has(item.id)
          const activeItem = activeTocId === item.id
          return (
            <li key={item.id}>
              <div className="flex items-start gap-[2px]">
                {hasChildren ? (
                  <button
                    type="button"
                    aria-label={`${isExpanded ? '收起' : '展开'} ${item.title}`}
                    aria-expanded={isExpanded}
                    className="mt-[3px] grid h-[22px] w-[20px] shrink-0 place-items-center rounded-[5px] border-0 bg-transparent p-0 text-ui-muted cursor-pointer hover:bg-[#e5ebd9] hover:text-ui-ink"
                    onClick={() => toggleTocBranch(item.id)}
                  >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                ) : (
                  <span className="w-[20px] shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  aria-current={activeItem ? 'location' : undefined}
                  className={tocButton({ active: activeItem })}
                  onClick={() => openChapter(item.chapterIndex, { fragment: item.fragment, tocId: item.id })}
                >
                  {item.title}
                </button>
              </div>
              {hasChildren && isExpanded && renderTocItems(item.children, depth + 1)}
            </li>
          )
        })}
      </ol>
    )
  }

  const atBookStart = chapterIndex <= 0 && pageIndex <= 0
  const atBookEnd = !!parsed && chapterIndex >= parsed.chapters.length - 1 && pageIndex >= totalPages - 1

  return (
    <div className={readerStyles.shell()}>
      {sidebarOpen && (
        <aside className={readerStyles.sidebar()} aria-label="阅读器侧栏">
          <div className="flex items-center justify-between gap-[8px] px-[2px]">
            <div className="flex items-center gap-[8px] min-w-0">
              <BookOpen size={16} className="shrink-0 text-[#4c6b85]" aria-hidden="true" />
              <h1 className="m-0 text-[14px] font-semibold text-[#303b2c] truncate">
                {book?.title ?? parsed?.title ?? 'EPUB 阅读器'}
              </h1>
            </div>
            <Tooltip content="收起侧栏">
              <Button
                aria-label="收起侧栏"
                size="custom"
                className="h-[28px] w-[28px] shrink-0 p-0"
                onClick={() => setSidebarOpen(false)}
              >
                <PanelLeftClose size={15} />
              </Button>
            </Tooltip>
          </div>

          <section className={readerStyles.panel()} aria-label="阅读器设置">
            <h2 className={readerStyles.panelTitle()}>
              <SlidersHorizontal size={14} />
              <span>阅读设置</span>
            </h2>
            <div className="flex flex-col gap-[10px]">
              <label className="flex flex-col gap-[5px] text-[12px] text-form-label">
                <span className="flex items-center justify-between">
                  <span>字体大小</span>
                  <span className="text-ui-ink font-medium tabular-nums">{settings.fontSize}px</span>
                </span>
                <input
                  type="range"
                  aria-label="字体大小"
                  min={14}
                  max={28}
                  step={1}
                  value={settings.fontSize}
                  onChange={event => updateSettings({ fontSize: Number(event.target.value) })}
                />
              </label>

              <div className="flex flex-col gap-[5px] text-[12px] text-form-label">
                <span>字重</span>
                <div className="grid grid-cols-4 gap-[4px]" role="group" aria-label="字重">
                  {fontWeights.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={settings.fontWeight === option.value}
                      className={optionButton({ selected: settings.fontWeight === option.value })}
                      onClick={() => updateSettings({ fontWeight: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex flex-col gap-[5px] text-[12px] text-form-label">
                <span className="flex items-center justify-between">
                  <span>行高</span>
                  <span className="text-ui-ink font-medium tabular-nums">{settings.lineHeight.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  aria-label="行高"
                  min={1.4}
                  max={2.2}
                  step={0.05}
                  value={settings.lineHeight}
                  onChange={event => updateSettings({ lineHeight: Number(event.target.value) })}
                />
              </label>

              <div className="flex flex-col gap-[5px] text-[12px] text-form-label">
                <span>分栏</span>
                <div className="grid grid-cols-2 gap-[4px]" role="group" aria-label="分栏">
                  {columnOptions.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={settings.columns === option.value}
                      className={optionButton({ selected: settings.columns === option.value })}
                      onClick={() => updateSettings({ columns: option.value })}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <Switch
                label="翻页动画"
                checked={settings.pageAnimation}
                onChange={pageAnimation => updateSettings({ pageAnimation })}
              />
            </div>
          </section>

          <section className={`${readerStyles.panel()} flex-1 min-h-0 flex flex-col overflow-hidden`} aria-label="书籍目录">
            <h2 className={readerStyles.panelTitle()}>
              <ListTree size={14} />
              <span>目录</span>
            </h2>
            <nav className="flex-1 min-h-0 overflow-y-auto pr-[2px]" aria-label="章节目录">
              {parsed ? renderTocItems(parsed.toc) : <p className="m-0 text-[12px] text-ui-muted">正在加载目录…</p>}
            </nav>
          </section>
        </aside>
      )}

      <main className={readerStyles.main()} aria-label="阅读主区域" onWheel={handleWheel}>
        <header className={readerStyles.header()}>
          <div className="flex items-center gap-[10px] min-w-0">
            {!sidebarOpen && (
              <Tooltip content="展开侧栏">
                <Button
                  aria-label="展开侧栏"
                  size="custom"
                  className="h-[30px] w-[30px] shrink-0 p-0"
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeftOpen size={15} />
                </Button>
              </Tooltip>
            )}
            <span className="text-[13px] font-medium text-[#4a5940] truncate">
              {currentChapter?.title ?? book?.title ?? 'EPUB 阅读'}
            </span>
            {parsed?.author && (
              <span className="text-[12px] text-ui-muted truncate [@media(max-width:650px)]:hidden">· {parsed.author}</span>
            )}
          </div>
          <span
            aria-label="阅读进度"
            className="px-[9px] py-[3px] rounded-[99px] bg-[#e4ecf2] text-[#3c5970] text-[12px] font-medium tabular-nums shrink-0"
          >
            {progress}%
          </span>
        </header>

        {loading ? (
          <div className={`${readerStyles.paper()} items-center justify-center text-ui-muted text-[14px]`}>
            正在加载电子书…
          </div>
        ) : !available || !parsed ? (
          <div className={`${readerStyles.paper()} items-center justify-center`}>
            <p className="m-0 text-[14px] text-action-danger text-center">{error || '无法打开电子书'}</p>
          </div>
        ) : (
          <article className={readerStyles.paper()}>
            <div
              ref={viewportRef}
              className={readerStyles.viewport()}
              style={{ ['--reader-page-h' as string]: `${Math.max(120, viewportSize.height - 24)}px` }}
            >
              <div
                className="h-full overflow-hidden mx-auto"
                style={{ width: `${colsPerPage === 2 ? colWidth * 2 + colGap : colWidth}px` }}
              >
                <div
                  key={chapterIndex}
                  ref={flowingRef}
                  data-reader-body
                  className={readerStyles.content()}
                  style={{
                    width: `${colWidth}px`,
                    height: `${Math.max(120, viewportSize.height)}px`,
                    columnWidth: `${colWidth}px`,
                    columnGap: `${colGap}px`,
                    columnFill: 'auto',
                    transform: `translateX(-${pageIndex * pageStride}px)`,
                    transition: animateTurn && settings.pageAnimation ? 'transform 160ms ease-out' : 'none',
                    fontSize: `${settings.fontSize}px`,
                    fontWeight: settings.fontWeight,
                    lineHeight: settings.lineHeight,
                  }}
                  onClick={handleContentClick}
                  dangerouslySetInnerHTML={{ __html: rendered.html }}
                />
              </div>
            </div>
          </article>
        )}

        {parsed && available && !loading && (
          <footer className={readerStyles.footer()} aria-label="翻页导航">
            <Button disabled={atBookStart} onClick={() => turnPage(-1)}>
              <ChevronLeft size={16} />
              上一页
            </Button>
            <span aria-label="页码" className="text-[12px] text-ui-muted tabular-nums">
              第 {pageIndex + 1} / {totalPages} 页 · {chapterIndex + 1}/{parsed.chapters.length} 章
            </span>
            <Button disabled={atBookEnd} onClick={() => turnPage(1)}>
              下一页
              <ChevronRight size={16} />
            </Button>
          </footer>
        )}
      </main>

      <Toast message={error} onClose={() => setError('')} />
    </div>
  )
}
