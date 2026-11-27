import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, SlidersHorizontal, ListTree } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { computeReadingProgress, parseEpub, type EpubTocItem, type ParsedEpub } from '../core/epub'
import { defaultEpubReaderSettings, readEpubReaderSettings, saveEpubReaderSettings, type EpubFontWeight, type EpubReaderSettings } from '../core/epub-preferences'
import { getBookBytes } from '../core/epub-storage'
import { readLocalSnapshot, storageKey } from '../core/local-workspace'
import { isActive, type Book } from '../core/model'
import { rpc } from '../core/protocol'
import { Button, Tooltip } from '../newtab/ui'
import { Toast } from '../shared/Toast'
import { useDocumentTitle } from '../document/useDocumentTitle'
import { renderChapterHtml } from './chapter-renderer'

const readerStyles = tv({
  slots: {
    shell: 'min-h-dvh flex flex-col bg-ui-canvas text-ui-text',
    topbar: 'sticky top-0 z-20 flex items-center justify-between gap-[12px] px-[20px] py-[12px] bg-[#f7f8efeb] backdrop-blur-[12px] border-b border-b-solid border-ui-line [@media(max-width:650px)]:px-[14px]',
    layout: 'flex flex-1 min-h-0 max-w-[1520px] w-full mx-auto gap-[24px] px-[24px] py-[20px] [@media(max-width:850px)]:flex-col [@media(max-width:650px)]:px-[14px]',
    sidebar: 'w-[290px] shrink-0 flex flex-col gap-[16px] [@media(max-width:850px)]:w-full',
    panel: 'rounded-[16px] bg-ui-surface border border-solid border-white p-[16px] shadow-[0_6px_24px_#4c683408]',
    panelTitle: 'flex items-center gap-[7px] text-[13px] font-semibold text-[#384730] mb-[12px]',
    main: 'flex-1 min-w-0 flex flex-col gap-[16px]',
    paper: 'rounded-[22px] bg-ui-surface border border-solid border-white px-[40px] py-[34px] shadow-[0_10px_35px_#4c68340a] [@media(max-width:650px)]:px-[18px] [@media(max-width:650px)]:py-[20px]',
    content: 'mx-auto max-w-[760px] text-[#2f392a] [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:h-auto [&_img]:mx-auto [&_img]:my-[16px] [&_img]:block [&_img]:rounded-[8px] [&_svg]:max-w-full [&_svg]:h-auto [&_h1]:text-[1.6em] [&_h1]:leading-[1.35] [&_h1]:mt-[0.4em] [&_h1]:mb-[0.7em] [&_h2]:text-[1.35em] [&_h2]:leading-[1.4] [&_h2]:mt-[1.1em] [&_h2]:mb-[0.55em] [&_h3]:text-[1.15em] [&_h3]:mt-[1em] [&_h3]:mb-[0.45em] [&_p]:my-[0.75em] [&_blockquote]:border-l-[3px] [&_blockquote]:border-l-solid [&_blockquote]:border-[#b2c495] [&_blockquote]:pl-[14px] [&_blockquote]:text-[#5a6652] [&_a]:text-[#4e7238] [&_a]:underline [&_pre]:overflow-x-auto [&_pre]:rounded-[10px] [&_pre]:bg-[#f2f5eb] [&_pre]:p-[12px]',
    navBar: 'flex items-center justify-between gap-[12px] pt-[12px]',
  },
})()

const weightButton = tv({
  base: 'py-[5px] px-[4px] rounded-[7px] text-[11px] border border-solid cursor-pointer transition-colors',
  variants: {
    selected: {
      true: 'bg-[#4c6b85] text-white border-[#4c6b85] font-semibold',
      false: 'bg-[#f7f8f2] text-ui-ink border-form-line hover:bg-[#edf2f6]',
    },
  },
})

const tocButton = tv({
  base: 'block w-full text-left border-0 rounded-[8px] px-[8px] py-[6px] text-[12px] leading-[1.45] cursor-pointer transition-colors [overflow-wrap:anywhere]',
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
  const [navSeq, setNavSeq] = useState(0)
  const [progress, setProgress] = useState(0)
  const [settings, setSettings] = useState<EpubReaderSettings>(defaultEpubReaderSettings)

  const articleRef = useRef<HTMLDivElement | null>(null)
  const pendingFragment = useRef<string | undefined>(undefined)
  const initialRestoreRatio = useRef<number | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const availableRef = useRef(true)
  const parsedRef = useRef<ParsedEpub | null>(null)
  const latestPosition = useRef<{ chapterIndex: number; scrollRatio: number; progress: number }>({
    chapterIndex: 0,
    scrollRatio: 0,
    progress: 0,
  })

  availableRef.current = available
  parsedRef.current = parsed

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
    }, 350)
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
        if (disposed) return
        const restoredChapter = Math.max(0, Math.min(epub.chapters.length - 1, entity.chapterIndex))
        initialRestoreRatio.current = entity.scrollRatio
        latestPosition.current = {
          chapterIndex: restoredChapter,
          scrollRatio: entity.scrollRatio,
          progress: entity.progress,
        }
        setParsed(epub)
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

  useEffect(() => {
    if (!parsed || !available) return
    const raf = requestAnimationFrame(() => {
      const fragment = pendingFragment.current
      pendingFragment.current = undefined
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)

      if (fragment) {
        const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`)
        if (target) target.scrollIntoView({ block: 'start' })
        else window.scrollTo({ top: 0, behavior: 'auto' })
      } else if (initialRestoreRatio.current !== null) {
        const ratio = initialRestoreRatio.current
        initialRestoreRatio.current = null
        window.scrollTo({ top: Math.round(maxScroll * ratio), behavior: 'auto' })
        if (maxScroll <= 0) {
          scheduleSave(chapterIndex, 1, computeReadingProgress(parsed.chapters, chapterIndex, 1))
        }
        return
      } else {
        window.scrollTo({ top: 0, behavior: 'auto' })
      }

      if (navSeq > 0 || maxScroll <= 0) {
        const ratio = maxScroll <= 0 ? 1 : Math.max(0, Math.min(1, window.scrollY / maxScroll))
        scheduleSave(chapterIndex, ratio, computeReadingProgress(parsed.chapters, chapterIndex, ratio))
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [chapterIndex, navSeq, parsed, available, rendered.html, scheduleSave])

  useEffect(() => {
    if (!parsed || !available) return
    const onScroll = () => {
      const epub = parsedRef.current
      if (!epub || !availableRef.current) return
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      const ratio = maxScroll <= 0 ? 1 : Math.max(0, Math.min(1, window.scrollY / maxScroll))
      const nextProgress = computeReadingProgress(epub.chapters, chapterIndex, ratio)
      scheduleSave(chapterIndex, ratio, nextProgress)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [parsed, available, chapterIndex, scheduleSave])

  function goToChapter(targetIndex: number, fragment?: string) {
    if (!parsed) return
    const clamped = Math.max(0, Math.min(parsed.chapters.length - 1, targetIndex))
    pendingFragment.current = fragment
    initialRestoreRatio.current = null
    setChapterIndex(clamped)
    setNavSeq(seq => seq + 1)
  }

  function updateSettings(patch: Partial<EpubReaderSettings>) {
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
    const targetChapter = parsed.chapters.findIndex(chapter => chapter.href === resolved.path)
    if (targetChapter >= 0) {
      goToChapter(targetChapter, resolved.fragment)
    }
  }

  function renderTocItems(items: EpubTocItem[], depth = 0) {
    return (
      <ol className={`list-none m-0 p-0 space-y-[2px] ${depth > 0 ? 'pl-[14px]' : ''}`}>
        {items.map(item => {
          const activeItem = item.chapterIndex === chapterIndex
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={activeItem ? 'location' : undefined}
                className={tocButton({ active: activeItem })}
                onClick={() => goToChapter(item.chapterIndex, item.fragment)}
              >
                {item.title}
              </button>
              {item.children.length > 0 && renderTocItems(item.children, depth + 1)}
            </li>
          )
        })}
      </ol>
    )
  }

  return (
    <div className={readerStyles.shell()}>
      <header className={readerStyles.topbar()}>
        <div className="flex items-center gap-[10px] min-w-0">
          <Tooltip content={sidebarOpen ? '收起侧栏' : '展开侧栏'}>
            <Button
              aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
              size="custom"
              className="h-[32px] w-[32px] shrink-0 p-0"
              onClick={() => setSidebarOpen(open => !open)}
            >
              {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </Button>
          </Tooltip>
          <BookOpen size={16} className="shrink-0 text-[#4c6b85]" aria-hidden="true" />
          <h1 className="m-0 text-[15px] font-semibold text-[#303b2c] truncate">
            {book?.title ?? parsed?.title ?? 'EPUB 阅读器'}
          </h1>
          {parsed?.author && (
            <span className="text-[12px] text-ui-muted truncate [@media(max-width:650px)]:hidden">· {parsed.author}</span>
          )}
        </div>
        <div className="flex items-center gap-[12px] shrink-0 text-[12px] text-ui-muted">
          {currentChapter && <span className="truncate max-w-[260px] [@media(max-width:850px)]:hidden">{currentChapter.title}</span>}
          <span
            aria-label="阅读进度"
            className="px-[9px] py-[3px] rounded-[99px] bg-[#e4ecf2] text-[#3c5970] font-medium tabular-nums"
          >
            {progress}%
          </span>
        </div>
      </header>

      {loading ? (
        <main className="flex-1 grid place-items-center p-[32px] text-ui-muted text-[14px]">
          正在加载电子书…
        </main>
      ) : !available || !parsed ? (
        <main className="flex-1 grid place-items-center p-[32px]">
          <div className="max-w-[440px] rounded-[18px] bg-ui-surface border border-solid border-white p-[24px] text-center shadow-[0_10px_35px_#4c68340a]">
            <p className="m-0 text-[14px] text-action-danger">{error || '无法打开电子书'}</p>
          </div>
        </main>
      ) : (
        <div className={readerStyles.layout()}>
          {sidebarOpen && (
            <aside className={readerStyles.sidebar()} aria-label="阅读器侧栏">
              <section className={readerStyles.panel()} aria-label="阅读器设置">
                <h2 className={readerStyles.panelTitle()}>
                  <SlidersHorizontal size={14} />
                  <span>阅读设置</span>
                </h2>
                <div className="flex flex-col gap-[14px]">
                  <label className="flex flex-col gap-[6px] text-[12px] text-form-label">
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

                  <div className="flex flex-col gap-[6px] text-[12px] text-form-label">
                    <span>字重</span>
                    <div className="grid grid-cols-4 gap-[4px]" role="group" aria-label="字重">
                      {fontWeights.map(option => {
                        const selected = settings.fontWeight === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={selected}
                            className={weightButton({ selected })}
                            onClick={() => updateSettings({ fontWeight: option.value })}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <label className="flex flex-col gap-[6px] text-[12px] text-form-label">
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
                </div>
              </section>

              <section className={`${readerStyles.panel()} flex-1 min-h-0 flex flex-col`} aria-label="书籍目录">
                <h2 className={readerStyles.panelTitle()}>
                  <ListTree size={14} />
                  <span>目录</span>
                </h2>
                <nav className="max-h-[58vh] overflow-y-auto pr-[4px]" aria-label="章节目录">
                  {renderTocItems(parsed.toc)}
                </nav>
              </section>
            </aside>
          )}

          <main className={readerStyles.main()} aria-label="阅读主区域">
            <article className={readerStyles.paper()}>
              <div
                ref={articleRef}
                data-reader-body
                className={readerStyles.content()}
                style={{
                  fontSize: `${settings.fontSize}px`,
                  fontWeight: settings.fontWeight,
                  lineHeight: settings.lineHeight,
                }}
                onClick={handleContentClick}
                dangerouslySetInnerHTML={{ __html: rendered.html }}
              />
            </article>

            <nav className={readerStyles.navBar()} aria-label="章节导航">
              <Button
                disabled={chapterIndex <= 0}
                onClick={() => goToChapter(chapterIndex - 1)}
              >
                <ChevronLeft size={16} />
                上一章
              </Button>
              <span className="text-[12px] text-ui-muted tabular-nums">
                {chapterIndex + 1} / {parsed.chapters.length}
              </span>
              <Button
                disabled={chapterIndex >= parsed.chapters.length - 1}
                onClick={() => goToChapter(chapterIndex + 1)}
              >
                下一章
                <ChevronRight size={16} />
              </Button>
            </nav>
          </main>
        </div>
      )}

      <Toast message={error} onClose={() => setError('')} />
    </div>
  )
}
