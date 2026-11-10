import { useState } from 'react'
import { Cloud, Download, Upload, RotateCcw, Trash2, AlertTriangle } from 'lucide-react'
import { type Entity, type Conflict, type Document } from '../core/model'
import { rpc, syncStatusLabels, type Snapshot } from '../core/protocol'
import ConnectionForm from './ConnectionForm'
import type { Act } from './Editor'
import { Button, Modal } from './ui'

export default function SettingsPanel({ data, act, receive, onError }: { data: Snapshot & { document: Document }; act: Act; receive: (data: Snapshot) => void; onError: (error: string) => void }) {
  const [nickname, setNickname] = useState(data.document.entities.profile.title)
  const [pending, setPending] = useState<{ data: unknown; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
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
    <section className="settings-card"><h2>个人偏好</h2><label>显示昵称<input aria-label="显示昵称" value={nickname} maxLength={80} onChange={event => { const value = event.target.value; setNickname(value); if (value.trim()) void act({ type: 'edit', id: 'profile', patch: { title: value } }) }} /></label></section>
    {data.conflicts.length > 0 && <section className="settings-card conflict-section"><h2><AlertTriangle size={16} />选择要保留的版本</h2><p className="muted">两个版本均已保留在本机。处理完后继续同步，你也可以继续整理其他收藏。</p>{data.conflicts.map(conflict => <ConflictChoice key={conflict.id} conflict={conflict} busy={busy} choose={side => void execute(async () => { const result = await rpc({ type: 'resolve', sourceId: data.sourceId!, conflictId: conflict.id, side }); if (result.snapshot) receive(result.snapshot) })} />)}</section>}
    <section className="settings-card"><h2>连接与同步</h2><p className="muted" role="status">{syncStatusLabels[data.status]}{data.error ? ` · ${data.error}` : ''}</p><div className="sync-detail"><span>上次同步：{data.lastSync ? new Date(data.lastSync).toLocaleString('zh-CN') : '尚未完成'}</span><Button disabled={busy} onClick={() => void execute(async () => { const result = await rpc({ type: 'sync', sourceId: data.sourceId! }); if (result.snapshot) receive(result.snapshot) })}><Cloud size={16} />立即同步</Button></div><ConnectionForm key={data.sourceId} initial={data.connection} connected done={receive} onError={onError} /></section>
    <section className="settings-card"><h2>备份与迁移</h2><p className="muted">备份包含收藏、顺序、待办与回收站；不包含网盘登录信息或 WebDAV 密码。</p>{data.connection?.kind === 'quark' && <p className="muted">夸克的「拾页收藏」目录保留历史版本用于合并与恢复，暂不自动删除。回收站到期清理当前数据后，历史备份仍可能包含旧内容。</p>}<div className="backup-actions"><Button disabled={busy} onClick={() => void execute(async () => {
      const result = await rpc({ type: 'export', sourceId: data.sourceId! })
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `page-garden-${new Date().toISOString().slice(0, 10)}.json`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    })}><Download size={15} />导出备份</Button><label className="import-label"><Upload size={15} />导入备份<input aria-label="导入备份" type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void execute(async () => { if (file.size > 15_000_000) throw new Error('备份文件过大'); let value: unknown; try { value = JSON.parse(await file.text()) } catch { throw new Error('备份格式错误，请选择有效 JSON 文件') } await importBackup(value, false) }) }} /></label></div></section>
    <section className="settings-card"><h2><Trash2 size={16} />回收站 <span className="muted">{deleted.length}</span></h2><p className="muted">保留 30 天。恢复父级时会一并恢复随它删除的内容和待办标记。</p>{deleted.length ? <div className="recycle-list">{deleted.map(entity => <div key={entity.id} className="recycle-row"><div><strong>{entity.title}</strong><span>{entity.kind === 'space' ? '空间' : entity.kind === 'collection' ? '收藏块' : '链接'} · {Math.max(1, Math.ceil((30 * 86400_000 - Date.now() + entity.deletedAt!) / 86400_000))} 天后清理</span></div><Button aria-label={`恢复 ${entity.title}`} disabled={busy} onClick={() => void act({ type: 'restore', id: entity.id })}><RotateCcw size={14} />恢复</Button></div>)}</div> : <p className="settings-empty">回收站空空的</p>}</section>
    {pending && <Modal title="合并备份" close={() => setPending(null)}><p className="muted">{pending.message}</p><div className="modal-actions"><Button onClick={() => setPending(null)}>取消</Button><Button tone="primary" disabled={busy} onClick={() => void execute(() => importBackup(pending.data, true))}>确认导入</Button></div></Modal>}
  </>
}
function ConflictChoice({ conflict, busy, choose }: { conflict: Conflict; busy: boolean; choose: (side: 'local' | 'remote') => void }) {
  const labels: Record<string, string> = { title: '标题', url: '网址', note: '备注', todo: '待办', todoPosition: '待办顺序', position: '顺序', parentId: '位置', collapsed: '折叠状态' }
  return <article className="conflict-item" aria-label={`冲突 ${conflict.local?.title || conflict.remote?.title || '已删除内容'}`}><h3>{conflict.local?.title || conflict.remote?.title || '已删除内容'}</h3><p className="muted">冲突内容：{conflict.fields.map(field => labels[field] || field).join('、')}</p><div className="conflict-versions">{(['local', 'remote'] as const).map(side => <div key={side}><span className="eyebrow">{side === 'local' ? '本地版本' : '远端版本'}</span><Version entity={conflict[side]} /><Button disabled={busy} tone="primary" onClick={() => choose(side)}>{side === 'local' ? '保留本地版本' : '保留远端版本'}</Button></div>)}</div></article>
}
function Version({ entity }: { entity: Entity | null }) {
  if (!entity || entity.deletedAt !== null || entity.purged) return <p className="version-deleted">已删除</p>
  return <div className="version-content"><strong>{entity.title}</strong>{entity.kind === 'link' && <><span>{entity.url}</span>{entity.note && <p>{entity.note}</p>}<small>{entity.todo ? '已加入 Todo' : '未加入 Todo'}</small>{entity.todo && <small>待办顺序：{entity.todoPosition ?? entity.position}</small>}</>}<small>位置顺序：{entity.position}</small></div>
}
