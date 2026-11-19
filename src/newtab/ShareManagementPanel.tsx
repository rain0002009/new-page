import { useEffect, useId, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import {
  AlertTriangle,
  Check,
  Copy,
  Edit3,
  ExternalLink,
  FileText,
  Folder,
  Lock,
  Share2,
  Trash2,
} from 'lucide-react'
import type { Collection, Document, Note, ShareRecord } from '../core/model'
import type { Act } from './Editor'
import { Button, Modal, ModalPresence } from './ui'
import { formStyles } from './form-styles'
import { Toast } from '../shared/Toast'
import { DatePicker } from './DatePicker'
import { collectionToMarkdown, deleteTextShare, updateTextShare, validateTextShareLength } from '../core/see'

const fields = formStyles()

export default function ShareManagementPanel({
  doc,
  act,
  onLocateNote,
}: {
  doc: Document
  act: Act
  onLocateNote?: (noteId: string) => void
}) {
  const [activeTab, setActiveTab] = useState<'all' | 'collection' | 'note'>('all')
  const [editingShare, setEditingShare] = useState<ShareRecord | null>(null)
  const [deletingShare, setDeletingShare] = useState<ShareRecord | null>(null)
  const [message, setMessage] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const profile = doc.entities.profile
  const seeApiKey = profile?.kind === 'profile' ? profile.seeApiKey?.trim() ?? '' : ''

  // All active shares
  const allShares = Object.values(doc.entities).filter(
    (e): e is ShareRecord => e.kind === 'share' && !e.purged
  ).sort((a, b) => b.updatedAt - a.updatedAt)

  const filteredShares = allShares.filter(share => {
    if (activeTab === 'all') return true
    return share.entityKind === activeTab
  })

  async function copyLink(share: ShareRecord) {
    try {
      await navigator.clipboard.writeText(share.shortUrl)
      setCopiedId(share.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      setMessage('复制链接失败，请手动复制')
    }
  }

  const categoryTabs = [
    { id: 'all', label: '全部', count: allShares.length },
    { id: 'collection', label: '收藏块', count: allShares.filter(s => s.entityKind === 'collection').length },
    { id: 'note', label: '笔记', count: allShares.filter(s => s.entityKind === 'note').length },
  ] as const

  return (
    <div className="share-management-panel max-w-[960px] mx-auto py-[10px]">
      {/* Category Tabs */}
      <div className="flex items-center gap-[8px] pb-[16px] border-b border-b-solid border-ui-line mb-[20px]">
        {categoryTabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`flex items-center gap-[6px] px-[14px] py-[7px] rounded-[8px] text-[12px] font-medium transition-colors border-0 cursor-pointer ${
              activeTab === tab.id
                ? 'bg-[#eff5e4] text-[#4d633d] font-semibold shadow-[inset_0_1px_0_#ffffff70]'
                : 'bg-transparent text-[#7e8774] hover:bg-[#edf2e480]'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
            <span className="text-[10px] px-[6px] py-[1px] rounded-[4px] bg-[#e1e7d8] text-[#55634b]">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Share List */}
      {!filteredShares.length ? (
        <div className="py-[60px] text-center text-[#8d9782]">
          <div className="w-[48px] h-[48px] mx-auto mb-[12px] rounded-full bg-[#f0f4ea] grid place-items-center text-[#7e8f70]">
            <Share2 size={24} />
          </div>
          <h3 className="text-[15px] font-medium text-ui-ink mb-[6px]">暂无分享记录</h3>
          <p className="text-[12px] text-[#9ba491] m-0">在收藏块的笔记卡片上点击分享按钮即可生成公开短链</p>
        </div>
      ) : (
        <div className="space-y-[12px]">
          {filteredShares.map(share => {
            const isCollection = share.entityKind === 'collection'
            const sourceEntity = doc.entities[share.entityId]
            const entityAlive = sourceEntity && !sourceEntity.purged
            const isExpired = share.expireAt ? dayjs().unix() > share.expireAt : false

            return (
              <div
                key={share.id}
                className="p-[16px] bg-[#fffffcee] border border-solid border-white rounded-[14px] shadow-[0_4px_16px_#536c380f] backdrop-blur-[10px] flex items-center justify-between gap-[16px] flex-wrap [@media(max-width:650px)]:flex-col [@media(max-width:650px)]:items-start"
              >
                <div className="space-y-[6px] min-w-0 flex-1">
                  <div className="flex items-center gap-[8px] flex-wrap">
                    <span className="inline-flex items-center gap-[4px] px-[6px] py-[2px] rounded-[4px] bg-[#eef3e5] text-[#596d49] text-[10px] font-semibold">
                      {isCollection ? <Folder size={12} /> : <FileText size={12} />}
                      {isCollection ? '收藏块' : '笔记'}
                    </span>
                    <h4 className="text-[14px] font-semibold text-ui-ink truncate m-0" title={share.title}>
                      {share.title}
                    </h4>
                    {isExpired ? (
                      <span className="px-[6px] py-[2px] rounded-[4px] bg-[#ffedea] text-[#b44837] text-[10px] font-semibold">
                        已过期
                      </span>
                    ) : share.expireAt ? (
                      <span className="text-[10px] text-[#78886b]">
                        将于 {dayjs.unix(share.expireAt).format('YYYY/M/D HH:mm')} 到期
                      </span>
                    ) : (
                      <span className="text-[10px] text-[#637d50]">永久有效</span>
                    )}
                    {share.hasPassword && (
                      <span className="inline-flex items-center gap-[3px] text-[10px] text-[#9b7639]" title="已设置密码">
                        <Lock size={11} /> 密码保护
                      </span>
                    )}
                    {isCollection && share.includeNotes && (
                      <span className="text-[10px] text-[#556947] bg-[#eff5e6] px-[5px] py-[2px] rounded-[4px]">
                        含公开笔记
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-[8px] flex-wrap text-[11px]">
                    <a
                      href={share.shortUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[#4e6b38] underline hover:text-[#385324] truncate max-w-[360px]"
                    >
                      {share.shortUrl}
                    </a>
                    <button
                      type="button"
                      className="inline-flex items-center gap-[3px] text-[10px] px-[6px] py-[2px] rounded-[4px] bg-transparent hover:bg-[#edf2e4] text-[#6d7962] border border-solid border-[#dce3d3] cursor-pointer"
                      onClick={() => void copyLink(share)}
                    >
                      {copiedId === share.id ? <Check size={11} /> : <Copy size={11} />}
                      {copiedId === share.id ? '已复制' : '复制'}
                    </button>
                    <a
                      href={share.shortUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-[3px] text-[10px] text-[#7f8a75] hover:text-[#526442]"
                      title="在新标签页打开"
                    >
                      <ExternalLink size={12} />
                    </a>
                  </div>

                  <div className="text-[10px] text-[#919a86] flex items-center gap-[10px]">
                    {entityAlive ? (
                      <span>
                        来源{isCollection ? '收藏块' : '笔记'}：
                        <button
                          type="button"
                          className="text-[#556b43] underline bg-transparent border-0 p-0 cursor-pointer ml-[2px]"
                          onClick={() => onLocateNote?.(sourceEntity.id)}
                        >
                          {sourceEntity.title}
                        </button>
                      </span>
                    ) : (
                      <span className="text-[#a55243] flex items-center gap-[3px]">
                        <AlertTriangle size={11} /> 原{isCollection ? '收藏块' : '笔记'}已删除
                      </span>
                    )}
                    <span>更新于 {dayjs(share.updatedAt).format('YYYY-MM-DD HH:mm')}</span>
                  </div>
                </div>

                <div className="flex items-center gap-[8px] shrink-0">
                  <Button
                    size="regular"
                    aria-label={`修改分享 ${share.title}`}
                    onClick={() => setEditingShare(share)}
                  >
                    <Edit3 size={13} />
                    修改
                  </Button>
                  <Button
                    tone="danger"
                    size="regular"
                    aria-label={`删除分享 ${share.title}`}
                    onClick={() => setDeletingShare(share)}
                  >
                    <Trash2 size={13} />
                    删除
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Edit Share Modal */}
      <ModalPresence>
        {editingShare && (
          <EditShareModal
            share={editingShare}
            doc={doc}
            seeApiKey={seeApiKey}
            act={act}
            close={() => setEditingShare(null)}
            onSuccess={() => {
              setEditingShare(null)
              setMessage('分享已更新至最新内容')
            }}
          />
        )}
      </ModalPresence>

      {/* Delete Share Confirmation Modal */}
      <ModalPresence>
        {deletingShare && (
          <DeleteShareModal
            share={deletingShare}
            seeApiKey={seeApiKey}
            act={act}
            close={() => setDeletingShare(null)}
            onSuccess={() => {
              setDeletingShare(null)
              setMessage('分享已下线并删除')
            }}
          />
        )}
      </ModalPresence>

      <Toast message={message} onClose={() => setMessage('')} />
    </div>
  )
}

function EditShareModal({
  share,
  doc,
  seeApiKey,
  act,
  close,
  onSuccess,
}: {
  share: ShareRecord
  doc: Document
  seeApiKey: string
  act: Act
  close: () => void
  onSuccess: () => void
}) {
  const isCollection = share.entityKind === 'collection'
  const titleId = useId()
  const sourceEntity = doc.entities[share.entityId]
  const entityAlive = sourceEntity && !sourceEntity.purged

  const [title, setTitle] = useState(share.title)
  const [expireAt, setExpireAt] = useState<number | null>(share.expireAt ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lengthError, setLengthError] = useState('')

  const collectionMd = useMemo(() => {
    if (!isCollection || !entityAlive) return null
    return collectionToMarkdown(doc, share.entityId, { includeNotes: share.includeNotes })
  }, [doc, isCollection, entityAlive, share.entityId, share.includeNotes])

  const contentToSync = isCollection
    ? (collectionMd?.content ?? '')
    : (entityAlive && sourceEntity.kind === 'note' ? sourceEntity.body : '')

  const isEmptyCollection = isCollection && collectionMd?.itemCount === 0

  useEffect(() => {
    if (entityAlive && contentToSync) {
      try {
        validateTextShareLength(contentToSync)
        setLengthError('')
      } catch (cause) {
        setLengthError(cause instanceof Error ? cause.message : '内容超过 2MB 限制')
      }
    }
  }, [entityAlive, contentToSync])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!entityAlive) {
      setError(`原${isCollection ? '收藏块' : '笔记'}已被彻底删除，无法抓取最新内容更新外链`)
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
      await updateTextShare(seeApiKey, {
        domain: share.domain,
        slug: share.slug,
        title: title.trim() || share.title,
        content: contentToSync,
      })

      // Update local entity
      await act({
        type: 'update-share',
        id: share.id,
        title: title.trim() || share.title,
        expireAt,
      })

      onSuccess()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新分享失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="修改分享内容" close={close} size="regular" overflow="visible">
      <form onSubmit={submit} className="space-y-[16px]">
        {!entityAlive ? (
          <div className="p-[12px] bg-[#fff1ed] text-[#b14a38] text-[12px] rounded-[8px] border border-solid border-[#ecc9bf]">
            原{isCollection ? '收藏块' : '笔记'}已在收藏中被删除，无法获取最新内容更新远程分享。建议直接删除该失效分享。
          </div>
        ) : (
          <div className="p-[12px] bg-[#f5f8ed] text-[#556947] text-[11px] rounded-[8px] border border-solid border-[#dbe4cd]">
            确认更新将自动抓取原{isCollection ? '收藏块当前的最新卡片' : '笔记当前的最新正文'}同步至 s.ee 公开短链。
          </div>
        )}

        {isEmptyCollection && (
          <div className="p-[12px] bg-[#fff1ed] text-[#b14a38] text-[12px] rounded-[8px] border border-solid border-[#ecc9bf]">
            当前收藏块没有可导出的有效卡片，无法更新分享内容。
          </div>
        )}

        {lengthError && (
          <div className="p-[12px] bg-[#fff1ed] text-[#b14a38] text-[12px] rounded-[8px] border border-solid border-[#ecc9bf]">
            {lengthError}
          </div>
        )}

        <div className={fields.label()}>
          <label htmlFor={titleId}>分享标题</label>
          <input
            id={titleId}
            type="text"
            className={fields.control()}
            value={title}
            disabled={busy || !entityAlive}
            onChange={e => setTitle(e.target.value)}
            maxLength={255}
          />
        </div>

        <div className={fields.label()}>
          <label>有效期</label>
          <div className="mt-[7px]">
            <DatePicker value={expireAt} onChange={setExpireAt} disabled={busy || !entityAlive} />
          </div>
        </div>

        {error && <Toast message={error} onClose={() => setError('')} />}

        <div className="flex items-center justify-end gap-[10px] pt-[12px] border-t border-t-solid border-ui-line">
          <Button disabled={busy} onClick={close}>取消</Button>
          <Button
            type="submit"
            tone="primary"
            disabled={busy || !entityAlive || !!lengthError || isEmptyCollection}
          >
            {busy ? '正在更新…' : '确认更新'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteShareModal({
  share,
  seeApiKey,
  act,
  close,
  onSuccess,
}: {
  share: ShareRecord
  seeApiKey: string
  act: Act
  close: () => void
  onSuccess: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remoteFailed, setRemoteFailed] = useState(false)

  async function confirmDelete(forceLocalOnly = false) {
    setBusy(true)
    setError('')
    try {
      if (!forceLocalOnly && seeApiKey) {
        try {
          await deleteTextShare(seeApiKey, {
            domain: share.domain,
            slug: share.slug,
          })
        } catch (cause) {
          setRemoteFailed(true)
          throw cause
        }
      }
      // Remove locally directly (bypassing recycle bin)
      await act({ type: 'delete-share', id: share.id })
      onSuccess()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="删除分享" close={close} size="regular">
      <div className="space-y-[16px]">
        <div className="p-[14px] bg-[#fff2ec] rounded-[10px] border border-solid border-[#edd1c6]">
          <p className="text-[13px] font-semibold text-[#8e3b2e] mb-[6px]">
            确定要删除此分享记录吗？
          </p>
          <p className="text-[11px] text-[#7c5b55] leading-[1.6] m-0">
            该操作将向 s.ee 发送下线请求并永久释放该短链，同时从本地记录彻底抹除（不进入回收站）。原{share.entityKind === 'collection' ? '收藏块' : '笔记'}内容不受影响。
          </p>
        </div>

        <div className="text-[12px] text-ui-ink font-medium px-[4px]">
          条目：{share.title} ({share.shortUrl})
        </div>

        {error && (
          <div className="p-[10px] bg-[#feeceb] text-[#ad3828] text-[11px] rounded-[6px]">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-[12px] border-t border-t-solid border-ui-line">
          {remoteFailed ? (
            <Button
              tone="danger"
              disabled={busy}
              onClick={() => void confirmDelete(true)}
            >
              仅从本地移除
            </Button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-[8px]">
            <Button disabled={busy} onClick={close}>取消</Button>
            <Button
              tone="danger"
              disabled={busy}
              onClick={() => void confirmDelete(false)}
            >
              {busy ? '正在下线…' : '永久下线并删除'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
