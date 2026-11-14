import { lazy, Suspense, type ComponentProps } from 'react'

const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

export default function LazyMarkdownEditor(props: ComponentProps<typeof MarkdownEditor>) {
  return <Suspense fallback={<p role="status" className="text-[12px] text-ui-muted">正在加载编辑器…</p>}>
    <MarkdownEditor {...props} />
  </Suspense>
}
