import { useEffect, useRef, useState } from 'react'
import { Cloud, Download, Upload, RotateCcw, AlertTriangle, Unlink } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { type Entity, type Conflict, type Document } from '../core/model'
import { rpc, syncStatusLabels, type Snapshot } from '../core/protocol'
import ConnectionForm from './ConnectionForm'
import SeeSettings from './SeeSettings'
import Switch from './Switch'
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
  const [repairOpen, setRepairOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const repairRunning = useRef(false)
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
  async function repairQuark() {
    if (repairRunning.current || busy || data.status === 'syncing' || data.conflicts.length) return
    repairRunning.current = true
    try {
      await execute(async () => {
        const result = await rpc({ type: 'quark-repair', sourceId: data.sourceId! })
        if (result.snapshot) receive(result.snapshot)
        setRepairOpen(false)
      })
    } finally { repairRunning.current = false }
  }
  async function disconnectCloud() {
    await execute(async () => {
      const result = await rpc({ type: 'disconnect', sourceId: data.sourceId! })
      if (result.snapshot) receive(result.snapshot)
      setDisconnectOpen(false)
    })
  }
  const profile = data.document.entities.profile

  return <>
    <section className={styles.card()}><h2 className={styles.title()}>s.ee 服务配置</h2><p className={styles.description()}>配置 s.ee 服务的访问凭据，供图片上传等功能使用。API Key 随收藏库同步，并包含在导出备份中。</p><SeeSettings key={data.sourceId} value={profile.kind === 'profile' ? profile.seeApiKey ?? '' : ''} onSave={value => act({ type: 'edit', id: 'profile', patch: { seeApiKey: value } })} /></section>
    <section className={styles.card()}><h2 className={styles.title()}>个人偏好</h2>
      <div className="flex flex-col gap-[16px] mt-[16px]">
        <Switch label="自动接管 Markdown 地址" checked={takeover} disabled={busy} onChange={enabled => { void execute(async () => { await rpc({ type: 'markdown-takeover', enabled }); setTakeover(enabled) }) }} />
        <Switch label="流体背景动画" checked={profile.kind !== 'profile' || profile.fluidAnimation !== false} disabled={busy} onChange={enabled => { void execute(async () => { await act({ type: 'edit', id: 'profile', patch: { fluidAnimation: enabled } }) }) }} />
      </div>
      <label className={fields.label({ className: 'mt-[22px]' })}>显示昵称<input className={fields.control()} aria-label="显示昵称" value={nickname} maxLength={80} onChange={event => { const value = event.target.value; setNickname(value); if (value.trim()) void act({ type: 'edit', id: 'profile', patch: { title: value } }) }} /></label>
    </section>
    {data.conflicts.length > 0 && <section className={styles.card()}><h2 className={styles.title()}><AlertTriangle size={16} />选择要保留的版本</h2><p className={styles.description()}>两个版本均已保留在本机。处理完后继续同步，你也可以继续整理其他收藏。</p>{data.conflicts.map(conflict => <ConflictChoice key={conflict.id} conflict={conflict} busy={busy} choose={side => void execute(async () => { const result = await rpc({ type: 'resolve', sourceId: data.sourceId!, conflictId: conflict.id, side }); if (result.snapshot) receive(result.snapshot) })} />)}</section>}
    <section className={styles.card()}><h2 className={styles.title()}>连接与同步</h2><p className={styles.description()} role="status">{data.connection ? syncStatusLabels[data.status] : '当前为本地收藏库，仅保存在当前设备。如需多端同步或备份防丢，可连接网盘。'}</p>{data.connection && <div className={styles.sync()}><span>上次同步：{data.lastSync ? new Date(data.lastSync).toLocaleString('zh-CN') : '尚未完成'}</span><div className="flex flex-wrap gap-[8px]"><Button disabled={busy} onClick={() => void execute(async () => { const result = await rpc({ type: 'sync', sourceId: data.sourceId! }); if (result.snapshot) receive(result.snapshot) })}><Cloud size={16} />立即同步</Button>{data.connection?.kind === 'quark' && <Button disabled={busy || data.status === 'syncing' || data.conflicts.length > 0} onClick={() => setRepairOpen(true)}><RotateCcw size={16} />修复夸克同步</Button>}<Button disabled={busy} onClick={() => setDisconnectOpen(true)}><Unlink size={16} />断开云端同步</Button></div></div>}<ConnectionForm key={data.sourceId} initial={data.connection} connected={!!data.connection} done={receive} onError={onError} /></section>
    <section className={styles.card()}><h2 className={styles.title()}>备份与迁移</h2><p className={styles.description()}>备份包含收藏、完整笔记正文、顺序、待办与回收站；不包含网盘登录信息或 WebDAV 密码。</p>{data.connection?.kind === 'quark' && <p className={styles.description()}>夸克「页墟收藏」中只保留当前收藏.json 和笔记目录中的 Markdown，不保留同步历史。普通同步包含完整笔记正文；独立 Markdown 在新建或编辑保存时更新，网盘中的手工修改不会回写。重要修改前可导出备份。</p>}<div className={styles.backup()}><Button disabled={busy} onClick={() => void execute(async () => {
      const result = await rpc({ type: 'export', sourceId: data.sourceId! })
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `page-garden-${new Date().toISOString().slice(0, 10)}.json`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    })}><Download size={15} />导出备份</Button><label className={styles.importLabel()}><Upload size={15} />导入备份<input className={styles.file()} aria-label="导入备份" type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void execute(async () => { if (file.size > 15_000_000) throw new Error('备份文件过大'); let value: unknown; try { value = JSON.parse(await file.text()) } catch { throw new Error('备份格式错误，请选择有效 JSON 文件') } await importBackup(value, false) }) }} /></label></div></section>
    <ModalPresence>{disconnectOpen && <Modal title="断开云端同步" close={() => { if (!busy) setDisconnectOpen(false) }}>
      <p className="text-[14px] [overflow-wrap:anywhere]">确认断开云端同步？</p>
      <p className={feedbackStyles.muted({ className: 'mt-[12px]' })}>断开后当前设备上的空间、收藏和笔记将完整保留为本地收藏库继续使用，云端网盘数据不会被删除。</p>
      <div className="flex justify-end gap-[8px] mt-[24px]"><Button data-autofocus disabled={busy} onClick={() => setDisconnectOpen(false)}>取消</Button><Button tone="danger" disabled={busy} onClick={() => void disconnectCloud()}>{busy ? '正在断开…' : '确认断开'}</Button></div>
    </Modal>}</ModalPresence>
    <ModalPresence>{repairOpen && <Modal title="修复夸克同步" close={() => { if (!busy) setRepairOpen(false) }}>
      <p className="text-[14px] [overflow-wrap:anywhere]">将用当前本地收藏和完整笔记正文，重建夸克中缺失的「页墟收藏」文件夹、收藏.json 和笔记 Markdown 文件。</p>
      <p className={feedbackStyles.muted({ className: 'mt-[12px]' })}>云端已有完整收藏时会进行正常同步；遇到冲突需要选择保留的版本。</p>
      <p className={feedbackStyles.muted({ className: 'mt-[12px]' })}>修复无法找回本地已没有的内容。网络或登录失败时保留本地数据，可在恢复连接后重试。</p>
      <div className="flex justify-end gap-[8px] mt-[24px]"><Button data-autofocus disabled={busy} onClick={() => setRepairOpen(false)}>取消</Button><Button tone="primary" disabled={busy || data.status === 'syncing' || data.conflicts.length > 0} onClick={() => void repairQuark()}>{busy ? '正在修复…' : '确认修复'}</Button></div>
    </Modal>}</ModalPresence>
    <ModalPresence>{pending && <Modal title="合并备份" close={() => setPending(null)}><p className={feedbackStyles.muted()}>{pending.message}</p><div className="flex justify-end gap-[8px] mt-[24px]"><Button onClick={() => setPending(null)}>取消</Button><Button tone="primary" disabled={busy} onClick={() => void execute(() => importBackup(pending.data, true))}>确认导入</Button></div></Modal>}</ModalPresence>
  </>
}
function ConflictChoice({ conflict, busy, choose }: { conflict: Conflict; busy: boolean; choose: (side: 'local' | 'remote') => void }) {
  const labels: Record<string, string> = { title: '标题', body: '正文', url: '网址', note: '备注', todo: '待办', todoPosition: '待办顺序', position: '顺序', parentId: '位置', collapsed: '折叠状态', seeApiKey: 's.ee API Key', fluidAnimation: '流体背景动画' }
  return <article className={conflictStyles.item()} aria-label={`冲突 ${conflict.local?.title || conflict.remote?.title || '已删除内容'}`}><h3 className={conflictStyles.title()}>{conflict.local?.title || conflict.remote?.title || '已删除内容'}</h3><p className={feedbackStyles.muted()}>冲突内容：{conflict.fields.map(field => labels[field] || field).join('、')}</p><div className={conflictStyles.versions()}>{(['local', 'remote'] as const).map(side => <div key={side} className={conflictStyles.version()}><span className={conflictStyles.eyebrow()}>{side === 'local' ? '本地版本' : '远端版本'}</span><Version entity={conflict[side]} /><Button disabled={busy} tone="primary" onClick={() => choose(side)}>{side === 'local' ? '保留本地版本' : '保留远端版本'}</Button></div>)}</div></article>
}
function Version({ entity }: { entity: Entity | null }) {
  if (!entity || entity.deletedAt !== null || entity.purged) return <p className={conflictStyles.deleted()}>已删除</p>
  return <div className={conflictStyles.content()}><strong>{entity.title}</strong>{entity.kind === 'profile' && <><span className={conflictStyles.metadata()}>s.ee API Key：{entity.seeApiKey ? `已配置（末尾 ${entity.seeApiKey.slice(-4)}）` : '未配置'}</span><span className={conflictStyles.metadata()}>流体背景动画：{entity.fluidAnimation !== false ? '开启' : '关闭'}</span></>}{entity.kind === 'note' && <p className={conflictStyles.note()}>{entity.body}</p>}{entity.kind === 'link' && <><span className={conflictStyles.metadata()}>{entity.url}</span>{entity.note && <p className={conflictStyles.note()}>{entity.note}</p>}<small className={conflictStyles.metadata()}>{entity.todo ? '已加入 Todo' : '未加入 Todo'}</small>{entity.todo && <small className={conflictStyles.metadata()}>待办顺序：{entity.todoPosition ?? entity.position}</small>}</>}<small className={conflictStyles.metadata()}>位置顺序：{entity.position}</small></div>
}
