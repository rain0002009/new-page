import { useEffect, useRef } from 'react'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { replaceAll, $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

export default function MarkdownEditor({ value, readonly, onChange, onError, resource }: { value: string; readonly: boolean; onChange: (value: string) => void; onError: (message: string) => void; resource?: (url: string, image: boolean) => Promise<string> }) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<Crepe>()
  const replacing = useRef(false)
  const latest = useRef({ value, readonly, onChange, onError, resource })
  latest.current = { value, readonly, onChange, onError, resource }
  useEffect(() => {
    let cancelled = false
    const editor = new Crepe({ root: host.current!, defaultValue: latest.current.value, features: { [Crepe.Feature.Latex]: false, [Crepe.Feature.AI]: false, [Crepe.Feature.TopBar]: false, [Crepe.Feature.ImageBlock]: false } })
    instance.current = editor
    editor.setReadonly(latest.current.readonly)
    const resolve = async (url: string, image: boolean) => {
      const result = latest.current.resource ? await latest.current.resource(url, image) : url
      return /^(?:javascript|vbscript|data):/i.test(result) ? '' : result
    }
    editor.editor.use($prose(ctx => new Plugin({ props: {
      nodeViews: { image(node) {
        const dom = document.createElement('img'); dom.alt = String(node.attrs.alt ?? ''); dom.title = String(node.attrs.title ?? '')
        void resolve(String(node.attrs.src ?? ''), true).then(url => { if (!cancelled) dom.src = url }).catch(cause => latest.current.onError(cause.message))
        return { dom, ignoreMutation: () => true }
      } },
      markViews: { link(mark) {
        const dom = document.createElement('a'); dom.title = String(mark.attrs.title ?? '')
        void resolve(String(mark.attrs.href ?? ''), false).then(url => { if (!cancelled) dom.href = url }).catch(cause => latest.current.onError(cause.message))
        return { dom, contentDOM: dom, ignoreMutation: () => true }
      } },
    }, view: () => ({ update(view, previous) {
      if (!cancelled && !replacing.current && !latest.current.readonly && !previous.doc.eq(view.state.doc)) latest.current.onChange(ctx.get(serializerCtx)(view.state.doc))
    } }) })))
    void editor.create().then(() => {
      if (cancelled) { void editor.destroy(); return }
      const view = editor.editor.ctx.get(editorViewCtx)
      view.dom.setAttribute('role', 'textbox'); view.dom.setAttribute('aria-label', 'Markdown 正文'); view.dom.setAttribute('aria-multiline', 'true')
      editor.setReadonly(latest.current.readonly)
      if (editor.getMarkdown() !== latest.current.value) {
        replacing.current = true
        try { editor.editor.action(replaceAll(latest.current.value)) } finally { replacing.current = false }
      }
    }).catch(error => latest.current.onError(`编辑器加载失败：${error instanceof Error ? error.message : String(error)}`))
    return () => { cancelled = true; instance.current = undefined; void editor.destroy().catch(() => {}) }
  }, [])
  useEffect(() => { instance.current?.setReadonly(readonly) }, [readonly])
  useEffect(() => {
    const editor = instance.current
    if (!editor || editor.editor.status !== 'Created') return
    if (editor.getMarkdown() !== value) { replacing.current = true; try { editor.editor.action(replaceAll(value)) } finally { replacing.current = false } }
  }, [value])
  return <div ref={host} className="min-h-[55vh]" />
}
