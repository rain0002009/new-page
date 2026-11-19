import { useEffect, useId, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Lock, RefreshCw, Share2 } from 'lucide-react'
import type { Collection, Document, Note, ShareRecord } from '../core/model'
import type { Act } from './Editor'
import { Button, Modal, Select } from './ui'
import { formStyles } from './form-styles'
import { Toast } from '../shared/Toast'
import { DatePicker } from './DatePicker'
import Switch from './Switch'
import { collectionToMarkdown, createTextShare, fetchSeeDomains, updateTextShare, validateTextShareLength } from '../core/see'

const fields = formStyles()

export type ShareTarget =
  | { kind: 'note'; note: Note }
  | { kind: 'collection'; collection: Collection }

export function ShareModal({
  target,
  share,
  doc,
  act,
  close,
  onNavigateToShares,
  onNavigateToSettings,
}: {
  target: ShareTarget
  share?: ShareRecord
  doc: Document
  act: Act
  close: () => void
  onNavigateToShares?: () => void
  onNavigateToSettings?: () => void
}) {
  const profile = doc.entities.profile
  const seeApiKey = profile?.kind === 'profile' ? profile.seeApiKey?.trim() ?? '' : ''

  if (share && !share.purged) {
    return (
      <AlreadySharedModal
        target={target}
        share={share}
        doc={doc}
        seeApiKey={seeApiKey}
        close={close}
        onNavigateToShares={onNavigateToShares}
      />
    )
  }

  return (
    <CreateShareModal
      target={target}
      doc={doc}
      seeApiKey={seeApiKey}
      act={act}
      close={close}
      onNavigateToSettings={onNavigateToSettings}
    />
  )
}

function AlreadySharedModal({
  target,
  share,
  doc,
  seeApiKey,
  close,
  onNavigateToShares,
}: {
  target: ShareTarget
  share: ShareRecord
  doc: Document
  seeApiKey: string
  close: () => void
  onNavigateToShares?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(share.shortUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  async function syncLatest() {
    if (!seeApiKey) {
      setError('请先在设置中保存 s.ee API Key')
      return
    }
    setSyncing(true)
    setError('')
    try {
      let content = ''
      if (target.kind === 'note') {
        const latest = doc.entities[target.note.id] as Note | undefined
        if (!latest || latest.purged) throw new Error('原笔记已删除，无法同步')
        validateTextShareLength(latest.body)
        content = latest.body
      } else {
        const latest = doc.entities[target.collection.id] as Collection | undefined
        if (!latest || latest.purged) throw new Error('原收藏块已删除，无法同步')
        const md = collectionToMarkdown(doc, latest.id, { includeNotes: share.includeNotes })
        if (md.itemCount === 0) throw new Error('当前收藏块没有可导出的有效卡片')
        validateTextShareLength(md.content)
        content = md.content
      }

      await updateTextShare(seeApiKey, {
        domain: share.domain,
        slug: share.slug,
        title: share.title,
        content,
      })
      setMessage('分享内容已同步更新')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '同步更新失败，请重试')
    } finally {
      setSyncing(false)
    }
  }

  const isExpired = share.expireAt ? dayjs().unix() > share.expireAt : false
  const isCollection = target.kind === 'collection'

  return (
    <Modal title={isCollection ? '收藏块已分享' : '笔记已分享'} close={close} size="regular">
      <div className="space-y-[18px]">
        <div className="p-[14px] bg-[#f5f8ee] rounded-[10px] border border-solid border-[#e2e8d8]">
          <p className="text-[11px] text-[#718260] font-medium mb-[6px]">
            {isCollection ? '当前收藏块已生成公开短链，相同收藏块不允许再次分享：' : '当前笔记已生成公开短链，相同笔记不允许再次分享：'}
          </p>
          <h3 className="text-[14px] font-semibold text-ui-ink mb-[12px]">{share.title}</h3>
          <div className="flex items-center gap-[8px]">
            <input
              type="text"
              readOnly
              value={share.shortUrl}
              className={fields.control({ className: 'mt-0 py-[7px] px-[10px] text-[12px] select-all' })}
            />
            <Button
              tone={copied ? 'primary' : 'ghost'}
              className="shrink-0"
              aria-label="复制短链"
              onClick={() => void copyLink()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </Button>
            <Button
              size="icon"
              aria-label="在新标签页打开分享"
              onClick={() => window.open(share.shortUrl, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink size={15} />
            </Button>
          </div>
        </div>

        <div className="text-[11px] text-[#86927d] space-y-[4px] px-[4px]">
          <div>所属域名：<span className="font-mono text-ui-ink">{share.domain}</span></div>
          <div>时效状态：{isExpired ? (
            <span className="text-[#bf5e4d] font-semibold">已过期</span>
          ) : share.expireAt ? (
            <span>将于 {dayjs.unix(share.expireAt).format('YYYY年M月D日 HH:mm')} 过期</span>
          ) : (
            <span className="text-[#5f7a4d]">永久有效</span>
          )}</div>
          {share.hasPassword && <div className="text-[#a1783e] flex items-center gap-[4px]"><Lock size={12} /> 已配置访问密码</div>}
          {isCollection && share.includeNotes && <div className="text-[#556947]">已包含当时已公开的笔记链接</div>}
        </div>

        {error && <Toast message={error} onClose={() => setError('')} />}
        {message && <Toast message={message} onClose={() => setMessage('')} />}

        <div className="flex items-center justify-between pt-[10px] border-t border-t-solid border-ui-line">
          <div className="flex items-center gap-[8px]">
            <Button
              tone="primary"
              onClick={() => {
                close()
                onNavigateToShares?.()
              }}
            >
              前往分享管理
            </Button>
            <Button
              disabled={syncing}
              aria-label="同步最新内容"
              onClick={() => void syncLatest()}
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
              {syncing ? '正在同步…' : '同步最新内容'}
            </Button>
          </div>
          <Button onClick={close}>关闭</Button>
        </div>
      </div>
    </Modal>
  )
}

function CreateShareModal({
  target,
  doc,
  seeApiKey,
  act,
  close,
  onNavigateToSettings,
}: {
  target: ShareTarget
  doc: Document
  seeApiKey: string
  act: Act
  close: () => void
  onNavigateToSettings?: () => void
}) {
  const isCollection = target.kind === 'collection'
  const titleId = useId()
  const domainId = useId()
  const slugId = useId()
  const pwdId = useId()
  const includeNotesId = useId()

  const defaultTitle = isCollection ? target.collection.title : target.note.title
  const [title, setTitle] = useState(defaultTitle)
  const [includeNotes, setIncludeNotes] = useState(false)
  const [domain, setDomain] = useState('s.ee')
  const [domains, setDomains] = useState<string[]>(['s.ee'])
  const [expireAt, setExpireAt] = useState<number | null>(null)
  const [customSlug, setCustomSlug] = useState('')
  const [password, setPassword] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lengthError, setLengthError] = useState('')

  // Calculate markdown for collection
  const collectionMd = useMemo(() => {
    if (!isCollection) return null
    return collectionToMarkdown(doc, target.collection.id, { includeNotes })
  }, [doc, isCollection, target, includeNotes])

  const contentToShare = isCollection ? (collectionMd?.content ?? '') : target.note.body
  const isEmptyCollection = isCollection && (collectionMd?.itemCount === 0)

  // Check length limit <= 2097152 bytes
  useEffect(() => {
    try {
      validateTextShareLength(contentToShare)
      setLengthError('')
    } catch (cause) {
      setLengthError(cause instanceof Error ? cause.message : '内容超过 2MB 限制')
    }
  }, [contentToShare])

  // Fetch domains
  useEffect(() => {
    if (!seeApiKey) return
    let active = true
    void fetchSeeDomains(seeApiKey).then(list => {
      if (!active) return
      setDomains(list)
      if (list.length) {
        setDomain(prev => list.includes(prev) ? prev : list[0])
      }
    }).catch(() => {})
    return () => { active = false }
  }, [seeApiKey])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!seeApiKey) {
      setError(`请先在设置页保存 s.ee API Key，再分享${isCollection ? '收藏块' : '笔记'}`)
      return
    }
    if (isEmptyCollection) {
      setError('当前收藏块没有可导出的有效卡片')
      return
    }
    if (lengthError) {
      setError(lengthError)
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await createTextShare(seeApiKey, {
        title: title.trim() || defaultTitle,
        content: contentToShare,
        domain,
        expire_at: expireAt,
        custom_slug: customSlug.trim() || undefined,
        password: password.trim() || undefined,
      })

      const shareId = crypto.randomUUID()
      const saved = await act({
        type: 'add-share',
        id: shareId,
        entityKind: isCollection ? 'collection' : 'note',
        entityId: isCollection ? target.collection.id : target.note.id,
        domain,
        slug: result.slug,
        shortUrl: result.shortUrl,
        title: title.trim() || defaultTitle,
        expireAt,
        hasPassword: !!password.trim(),
        includeNotes: isCollection ? includeNotes : undefined,
      })

      if (saved) {
        close()
      } else {
        setError('分享创建成功，但本地记录保存失败，请刷新查看')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建分享失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={isCollection ? '分享收藏块' : '分享笔记'} close={close} size="regular" overflow="visible">
      <form onSubmit={submit} className="space-y-[16px]">
        {!seeApiKey && (
          <div className="p-[12px] rounded-[8px] bg-[#fff5ea] text-[#9b5837] text-[12px] border border-solid border-[#edd5c0]">
            未检测到 s.ee API Key。
            <button
              type="button"
              className="ml-[6px] underline font-semibold text-[#804223] cursor-pointer bg-transparent border-0 p-0"
              onClick={() => {
                close()
                onNavigateToSettings?.()
              }}
            >
              前往设置
            </button>
          </div>
        )}

        {isEmptyCollection && (
          <div className="p-[12px] rounded-[8px] bg-[#fff5ea] text-[#9b5837] text-[12px] border border-solid border-[#edd5c0]">
            {includeNotes && collectionMd?.noteCount.unshared
              ? '当前收藏块没有可导出的有效卡片（未分享的笔记不会被包含）。'
              : '当前收藏块没有可导出的有效卡片。'}
          </div>
        )}

        {lengthError && (
          <div className="p-[12px] rounded-[8px] bg-[#fff0ea] text-[#ad483b] text-[12px] border border-solid border-[#eccbc2]">
            {lengthError}
          </div>
        )}

        {isCollection && ((collectionMd?.noteCount.shared ?? 0) + (collectionMd?.noteCount.unshared ?? 0)) > 0 && (
          <div>
            <Switch
              label="是否分享笔记"
              checked={includeNotes}
              disabled={busy}
              onChange={setIncludeNotes}
            />
            {includeNotes && (
              <p className="mt-[2px] text-[11px] text-[#718260] leading-relaxed">
                {collectionMd && collectionMd.noteCount.shared > 0
                  ? `已并入 ${collectionMd.noteCount.shared} 篇已公开笔记${collectionMd.noteCount.unshared > 0 ? `；其余 ${collectionMd.noteCount.unshared} 篇未分享的笔记不会被包含。` : '。'}`
                  : '当前收藏块无已公开笔记，未分享的笔记不会被包含。'}
              </p>
            )}
          </div>
        )}

        <div className={fields.label()}>
          <label htmlFor={titleId}>分享标题</label>
          <input
            id={titleId}
            type="text"
            className={fields.control()}
            value={title}
            disabled={busy}
            onChange={e => setTitle(e.target.value)}
            placeholder="输入对外展示的分享标题"
            maxLength={255}
          />
        </div>

        <div className={fields.label()}>
          <label htmlFor={domainId}>分享域名</label>
          <div className="mt-[7px]">
            <Select
              id={domainId}
              label="分享域名"
              value={domain}
              options={domains.map(d => ({ value: d, label: d }))}
              onChange={setDomain}
              disabled={busy || !domains.length}
              size="control"
            />
          </div>
        </div>

        <div className={fields.label()}>
          <label>有效期</label>
          <div className="mt-[7px]">
            <DatePicker value={expireAt} onChange={setExpireAt} disabled={busy} />
          </div>
        </div>

        <div>
          <button
            type="button"
            className="flex items-center gap-[4px] text-[11px] text-[#788869] font-medium hover:text-[#556947] bg-transparent border-0 p-0 cursor-pointer"
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            高级选项（自定义后缀与密码）
          </button>

          {showAdvanced && (
            <div className="mt-[10px] p-[12px] bg-[#f8faef] rounded-[8px] border border-solid border-[#e4ebd8] space-y-[12px]">
              <div className={fields.label({ className: 'mb-0' })}>
                <label htmlFor={slugId}>自定义短链后缀（选填）</label>
                <input
                  id={slugId}
                  type="text"
                  className={fields.control()}
                  value={customSlug}
                  disabled={busy}
                  onChange={e => setCustomSlug(e.target.value)}
                  placeholder="例如 my-share-slug"
                  pattern="[a-zA-Z0-9_-]*"
                />
              </div>

              <div className={fields.label({ className: 'mb-0' })}>
                <label htmlFor={pwdId}>访问密码（选填，3~32 位）</label>
                <input
                  id={pwdId}
                  type="password"
                  autoComplete="new-password"
                  className={fields.control()}
                  value={password}
                  disabled={busy}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="访问提取密码"
                  minLength={3}
                  maxLength={32}
                />
              </div>
            </div>
          )}
        </div>

        {error && <Toast message={error} onClose={() => setError('')} />}

        <div className="flex items-center justify-end gap-[10px] pt-[12px] border-t border-t-solid border-ui-line">
          <Button disabled={busy} onClick={close}>取消</Button>
          <Button
            type="submit"
            tone="primary"
            disabled={busy || !seeApiKey || !!lengthError || isEmptyCollection}
          >
            <Share2 size={15} />
            {busy ? '正在发布…' : '确认分享'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
