import { useEffect, useState } from 'react'
import { Cloud, Download, Upload, RotateCcw, Trash2, AlertTriangle } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { type Entity, type Conflict, type Document } from '../core/model'
import { rpc, syncStatusLabels, type Snapshot } from '../core/protocol'
import ConnectionForm from './ConnectionForm'
import type { Act } from './Editor'
import { Button, Modal, ModalPresence } from './ui'
import { feedbackStyles, formStyles } from './form-styles'

const styles = tv({
  slots: {
    card: 'p-[25px] border border-solid border-white rounded-[13px] bg-ui-dialog mb-[20px] backdrop-blur-[25px] shadow-[0_10px_35px_#4c683410] [@media(max-width:650px)]:p-[18px]',
    title: 'text-[15px] [font-weight:550] mb-[9px] flex gap-[8px] items-center',
    description: 'mb-[15px] text-[11px] text-ui-muted [overflow-wrap:anywhere]',
    sync: 'flex justify-between items-center gap-[12px] text-[10px] text-[#9ca68f] [@media(max-width:650px)]:items-start [@media(max-width:650px)]:flex-col',
    backup: 'flex items-center gap-[16px]',
    importLabel: 'relative flex items-center gap-[8px] text-[12px] [font-weight:550] text-form-label m-0 cursor-pointer',
    file: 'absolute inset-0 w-full opacity-0 cursor-pointer p-0 m-0',
    recycleRow: 'flex items-center justify-between gap-[12px] py-[15px] border-t border-t-solid border-ui-line [@media(max-width:650px)]:flex-wrap',
    recycleTitle: 'text-[12px] [font-weight:550]',
    recycleMeta: 'block text-[9px] text-[#a4ad97] mt-[4px]',
    empty: 'p-[25px] text-center text-[11px] text-[#acb59f]',
  },
})()
const conflictStyles = tv({
  slots: {
    item: 'border-t border-t-solid border-ui-line py-[20px]',
    title: 'text-[13px] mb-[5px]',
    versions: 'grid grid-cols-2 gap-[12px] mt-[15px] [@media(max-width:650px)]:grid-cols-1',
    version: 'p-[16px] bg-[#f4f5ed] rounded-[10px] min-w-0',
    eyebrow: 'block text-[9px] [font-weight:650] tracking-[1px] text-[#989e90]',
    content: 'py-[15px] text-[12px] [overflow-wrap:anywhere] whitespace-pre-wrap',
    metadata: 'block text-[10px] text-[#96a288] my-[5px]',
    note: 'text-[11px] my-[10px]',
    deleted: 'py-[20px] text-[12px] text-[#af8c77]',
  },
})()
const fields = formStyles()

export default function SettingsPanel({ data, act, receive, onError }: { data: Snapshot & { document: Document }; act: Act; receive: (data: Snapshot) => void; onError: (error: string) => void }) {
  const [nickname, setNickname] = useState(data.document.entities.profile.title)
  const [pending, setPending] = useState<{ data: unknown; message: string } | null>(null)
  const [recycleAction, setRecycleAction] = useState<{ type: 'purge'; entity: Entity } | { type: 'empty-trash' } | null>(null)
  const [recycleError, setRecycleError] = useState('')
  const [busy, setBusy] = useState(false)
  const [takeover, setTakeover] = useState(true)
  useEffect(() => { void chrome.storage.local.get(['markdownTakeover', 'markdownTakeoverError']).then(value => { setTakeover(value.markdownTakeover !== false); if (value.markdownTakeoverError) onError(String(value.markdownTakeoverError)) }) }, [])
  async function execute(work: () => Promise<void>) {
    setBusy(true)
    try { await work() } catch (error) { onError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  async function importBackup(value: unknown, confirmed: boolean) {
    const result = await rpc({ type: 'import', sourceId: data.sourceId!, data: value, confirmed })
    if (result.confirmation) setPending({ data: value, message: result.confirmation })
    else if (result.snapshot) { receive(result.snapshot); setPending(null) }
  }
  const deleted = Object.values(data.document.entities).filter(e => !e.purged && e.deletedAt !== null && e.deletedBy === e.id).sort((a, b) => b.deletedAt! - a.deletedAt!)

  return <>
    <section className={styles.card()}><h2 className={styles.title()}>个人偏好</h2><label className={styles.description()}><input type="checkbox" aria-label="自动接管 Markdown 地址" checked={takeover} disabled={busy} onChange={event => { const enabled = event.target.checked; void execute(async () => { await rpc({ type: 'markdown-takeover', enabled }); setTakeover(enabled) }) }} />自动接管 Markdown 地址</label><label className={fields.label({ className: 'mt-[22px]' })}>显示昵称<input className={fields.control()} aria-label="显示昵称" value={nickname} maxLength={80} onChange={event => { const value = event.target.value; setNickname(value); if (value.trim()) void act({ type: 'edit', id: 'profile', patch: { title: value } }) }} /></label></section>
    {data.conflicts.length > 0 && <section className={styles.card()}><h2 className={styles.title()}><AlertTriangle size={16} />选择要保留的版本</h2><p className={styles.description()}>两个版本均已保留在本机。处理完后继续同步，你也可以继续整理其他收藏。</p>{data.conflicts.map(conflict => <ConflictChoice key={conflict.id} conflict={conflict} busy={busy} choose={side => void execute(async () => { const result = await rpc({ type: 'resolve', sourceId: data.sourceId!, conflictId: conflict.id, side }); if (result.snapshot) receive(result.snapshot) })} />)}</section>}
    <section className={styles.card()}><h2 className={styles.title()}>连接与同步</h2><p className={styles.description()} role="status">{syncStatusLabels[data.status]}{data.error ? ` · ${data.error}` : ''}</p><div className={styles.sync()}><span>上次同步：{data.lastSync ? new Date(data.lastSync).toLocaleString('zh-CN') : '尚未完成'}</span><Button disabled={busy} onClick={() => void execute(async () => { const result = await rpc({ type: 'sync', sourceId: data.sourceId! }); if (result.snapshot) receive(result.snapshot) })}><Cloud size={16} />立即同步</Button></div><ConnectionForm key={data.sourceId} initial={data.connection} connected done={receive} onError={onError} /></section>
    <section className={styles.card()}><h2 className={styles.title()}>备份与迁移</h2><p className={styles.description()}>备份包含收藏、完整笔记正文、顺序、待办与回收站；不包含网盘登录信息或 WebDAV 密码。</p>{data.connection?.kind === 'quark' && <p className={styles.description()}>夸克文件统一保存在「拾页收藏」：收藏.json、笔记目录中的 Markdown，以及同步历史目录。已合并历史保留最近 10 份，未合并版本继续保留。Markdown 由扩展自动更新，网盘中的手工修改不会回写。历史和导出备份仍可能含已删除内容。</p>}<div className={styles.backup()}><Button disabled={busy} onClick={() => void execute(async () => {
      const result = await rpc({ type: 'export', sourceId: data.sourceId! })
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `page-garden-${new Date().toISOString().slice(0, 10)}.json`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    })}><Download size={15} />导出备份</Button><label className={styles.importLabel()}><Upload size={15} />导入备份<input className={styles.file()} aria-label="导入备份" type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void execute(async () => { if (file.size > 15_000_000) throw new Error('备份文件过大'); let value: unknown; try { value = JSON.parse(await file.text()) } catch { throw new Error('备份格式错误，请选择有效 JSON 文件') } await importBackup(value, false) }) }} /></label></div></section>
    <section className={styles.card()}>
      <div className="flex items-start justify-between gap-[12px] mb-[9px]"><h2 className={styles.title()}><Trash2 size={16} />回收站 <span className={feedbackStyles.muted()}>{deleted.length}</span></h2><Button tone="danger" aria-label="清空回收站" disabled={busy || !deleted.length} onClick={() => { setRecycleError(''); setRecycleAction({ type: 'empty-trash' }) }}><Trash2 size={14} />清空</Button></div>
      <p className={styles.description()}>保留 30 天。恢复父级时会一并恢复随它删除的内容和待办标记。</p>
      {deleted.length ? <div>{deleted.map(entity => <div key={entity.id} className={styles.recycleRow()}>
        <div className="min-w-0 [overflow-wrap:anywhere]"><strong className={styles.recycleTitle()}>{entity.title}</strong><span className={styles.recycleMeta()}>{entity.kind === 'space' ? '空间' : entity.kind === 'collection' ? '收藏块' : entity.kind === 'note' ? '笔记' : '链接'} · {Math.max(1, Math.ceil((30 * 86400_000 - Date.now() + entity.deletedAt!) / 86400_000))} 天后清理</span></div>
        <div className="flex shrink-0 items-center gap-[8px]"><Button aria-label={`恢复 ${entity.title}`} disabled={busy} onClick={() => void execute(async () => { await act({ type: 'restore', id: entity.id }) })}><RotateCcw size={14} />恢复</Button><Button tone="danger" aria-label={`彻底删除 ${entity.title}`} disabled={busy} onClick={() => { setRecycleError(''); setRecycleAction({ type: 'purge', entity }) }}><Trash2 size={14} />删除</Button></div>
      </div>)}</div> : <p className={styles.empty()}>回收站空空的</p>}
    </section>
    <ModalPresence>{recycleAction && <Modal title={recycleAction.type === 'purge' ? '彻底删除' : '清空回收站'} close={() => { if (!busy) setRecycleAction(null) }}>
      <p className="text-[14px] [overflow-wrap:anywhere]">{recycleAction.type === 'purge' ? `彻底删除「${recycleAction.entity.title}」及其包含的内容？` : '彻底删除回收站中的全部内容？'}</p>
      <p className={feedbackStyles.muted({ className: 'mt-[12px]' })}>删除后无法从回收站恢复。</p>
      {recycleError && <p role="alert" className={feedbackStyles.error()}>{recycleError}</p>}
      <div className="flex justify-end gap-[8px] mt-[24px]"><Button data-autofocus disabled={busy} onClick={() => setRecycleAction(null)}>取消</Button><Button tone="danger" disabled={busy} onClick={() => void execute(async () => {
        const action = recycleAction.type === 'purge' ? { type: 'purge' as const, id: recycleAction.entity.id } : { type: 'empty-trash' as const }
        if (await act(action)) setRecycleAction(null)
        else setRecycleError('删除未完成，请关闭弹窗查看提示后重试')
      })}>{recycleAction.type === 'purge' ? '删除' : '清空'}</Button></div>
    </Modal>}</ModalPresence>
    <ModalPresence>{pending && <Modal title="合并备份" close={() => setPending(null)}><p className={feedbackStyles.muted()}>{pending.message}</p><div className="flex justify-end gap-[8px] mt-[24px]"><Button onClick={() => setPending(null)}>取消</Button><Button tone="primary" disabled={busy} onClick={() => void execute(() => importBackup(pending.data, true))}>确认导入</Button></div></Modal>}</ModalPresence>
  </>
}
function ConflictChoice({ conflict, busy, choose }: { conflict: Conflict; busy: boolean; choose: (side: 'local' | 'remote') => void }) {
  const labels: Record<string, string> = { title: '标题', body: '正文', url: '网址', note: '备注', todo: '待办', todoPosition: '待办顺序', position: '顺序', parentId: '位置', collapsed: '折叠状态' }
  return <article className={conflictStyles.item()} aria-label={`冲突 ${conflict.local?.title || conflict.remote?.title || '已删除内容'}`}><h3 className={conflictStyles.title()}>{conflict.local?.title || conflict.remote?.title || '已删除内容'}</h3><p className={feedbackStyles.muted()}>冲突内容：{conflict.fields.map(field => labels[field] || field).join('、')}</p><div className={conflictStyles.versions()}>{(['local', 'remote'] as const).map(side => <div key={side} className={conflictStyles.version()}><span className={conflictStyles.eyebrow()}>{side === 'local' ? '本地版本' : '远端版本'}</span><Version entity={conflict[side]} /><Button disabled={busy} tone="primary" onClick={() => choose(side)}>{side === 'local' ? '保留本地版本' : '保留远端版本'}</Button></div>)}</div></article>
}
function Version({ entity }: { entity: Entity | null }) {
  if (!entity || entity.deletedAt !== null || entity.purged) return <p className={conflictStyles.deleted()}>已删除</p>
  return <div className={conflictStyles.content()}><strong>{entity.title}</strong>{entity.kind === 'note' && <p className={conflictStyles.note()}>{entity.body}</p>}{entity.kind === 'link' && <><span className={conflictStyles.metadata()}>{entity.url}</span>{entity.note && <p className={conflictStyles.note()}>{entity.note}</p>}<small className={conflictStyles.metadata()}>{entity.todo ? '已加入 Todo' : '未加入 Todo'}</small>{entity.todo && <small className={conflictStyles.metadata()}>待办顺序：{entity.todoPosition ?? entity.position}</small>}</>}<small className={conflictStyles.metadata()}>位置顺序：{entity.position}</small></div>
}
