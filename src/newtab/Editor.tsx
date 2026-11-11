import { useState, type FormEvent } from 'react'
import { Info } from 'lucide-react'
import { active, parents, webUrl, type Action, type Document, type Entity } from '../core/model'
import { Button, Modal } from './ui'
import { feedbackStyles, formStyles } from './form-styles'

const fields = formStyles()

export type Act = (action: Action) => Promise<boolean>
export type EditorState =
  | { kind: 'space' }
  | { kind: 'collection'; parentId: string }
  | { kind: 'edit' | 'rename' | 'delete'; entity: Entity }

export default function Editor({ state, doc, act, close }: { state: EditorState; doc: Document; act: Act; close: () => void }) {
  const entity = 'entity' in state ? state.entity : null
  const [title, setTitle] = useState(entity?.title ?? '')
  const [url, setUrl] = useState(entity?.kind === 'link' ? entity.url : '')
  const [note, setNote] = useState(entity?.kind === 'link' ? entity.note : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const editing = state.kind === 'edit' || state.kind === 'rename'
  const titleMap: Record<EditorState['kind'], string> = { space: '新建空间', collection: '新建收藏块', edit: '编辑链接', rename: '重命名', delete: '移到回收站' }
  async function autoSave(patch: { title?: string; url?: string; note?: string }) {
    if (!entity || !editing) return
    if (patch.url !== undefined) { try { webUrl(patch.url); setError('') } catch { setError('请输入 HTTP 或 HTTPS 网址；已保存的有效网址保持不变'); return } }
    if (patch.title !== undefined && !patch.title.trim()) { setError('名称不能为空'); return }
    if (await act({ type: 'edit', id: entity.id, patch })) setError('')
    else setError('未能保存这次修改，请关闭弹窗查看提示后重试')
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true)
    let action: Action | null = null
    if (state.kind === 'space') action = { type: 'add-space', title }
    if (state.kind === 'collection') action = { type: 'add-collection', parentId: state.parentId, title }
    if (action) { if (await act(action)) close(); else setError('操作未完成，请检查输入；关闭弹窗可查看具体提示') }
    setBusy(false)
  }
  if (state.kind === 'delete' && entity) {
    const count = active(doc).filter(e => e.id === entity.id || parents(doc, e).some(p => p.id === entity.id)).length
    return <Modal title="移到回收站" close={close}><div><span className="grid place-items-center w-[55px] h-[55px] rounded-[17px] bg-[#eef2e6] text-[#82986b] mb-[28px] [@media(max-width:650px)]:hidden"><Info size={24} /></span><p className="mt-[16px] mb-[8px] text-[14px]">将「{entity.title}」移到回收站？</p><p className="mt-[16px] mb-[8px] text-[11px] text-ui-muted [line-height:1.8]">{entity.kind === 'space' ? `包括空间内 ${count - 1} 项内容。` : entity.kind === 'collection' ? `包括其中 ${count - 1} 个链接。` : ''}30 天内可以恢复，待办标记也会保留。</p></div>{error && <p role="alert" className={feedbackStyles.error()}>{error}</p>}<div className="flex justify-end gap-[8px] mt-[24px]"><Button onClick={close}>取消</Button><Button tone="danger" disabled={busy} onClick={async () => {
      if (entity.kind === 'space' && active(doc).filter(e => e.kind === 'space').length <= 1) { setError('请至少保留一个空间'); return }
      setBusy(true); if (await act({ type: 'delete', id: entity.id })) close(); else setError('删除未完成，请关闭弹窗查看提示后重试'); setBusy(false)
    }}>移到回收站</Button></div></Modal>
  }
  return <Modal title={titleMap[state.kind]} close={close}><form onSubmit={submit}>
      {state.kind === 'edit' && <label className={fields.label()}>网址<input className={fields.control()} aria-label="网址" type="url" required value={url} onChange={e => { setUrl(e.target.value); void autoSave({ url: e.target.value }) }} placeholder="https://" /></label>}
      <label className={fields.label()}>{['space', 'collection', 'rename'].includes(state.kind) ? '名称' : '标题'}<input className={fields.control()} aria-label={['space', 'collection', 'rename'].includes(state.kind) ? '名称' : '标题'} value={title} onChange={e => { setTitle(e.target.value); void autoSave({ title: e.target.value }) }} required={state.kind !== 'edit'} maxLength={1000} autoFocus  /></label>
      {state.kind === 'edit' && <label className={fields.label()}>备注<textarea className={fields.control({ className: 'resize-y min-h-[92px]' })} aria-label="备注" value={note} onChange={e => { setNote(e.target.value); void autoSave({ note: e.target.value }) }} maxLength={20_000} /></label>}
    {error && <p className={feedbackStyles.error()} role="status">{error}</p>}
    {!editing && <div className="flex justify-end gap-[8px] mt-[24px]"><Button onClick={close}>取消</Button><Button type="submit" tone="primary" disabled={busy}>创建</Button></div>}
  </form></Modal>
}
