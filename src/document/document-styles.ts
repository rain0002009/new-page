import { tv } from 'tailwind-variants/lite'

const documentLayout = tv({
  slots: {
    main: 'relative z-1 mx-auto min-h-screen px-[28px] py-[36px] [@media(max-width:650px)]:px-[16px]',
    header: 'flex flex-wrap items-center justify-end gap-[12px] mb-[24px] text-ui-sage',
    status: 'text-[11px] text-ui-muted mb-[12px]',
    columns: 'grid grid-cols-[190px_minmax(0,1fr)] gap-[24px] [@media(max-width:650px)]:grid-cols-1',
    sidebar: 'min-w-0',
    surface: 'min-w-0 rounded-[22px] bg-ui-surface border border-solid border-white p-[32px] [@media(max-width:650px)]:p-[16px]',
    title: 'block w-full text-[32px] font-semibold border-0 bg-transparent p-[8px] mb-[20px] focus:outline-none',
    error: 'rounded-[12px] bg-action-danger-surface p-[16px] mb-[16px] text-action-danger [overflow-wrap:anywhere]',
  },
  variants: { source: { note: { main: 'max-w-[1040px]' }, file: { main: 'max-w-[1160px]' } } },
  defaultVariants: { source: 'file' },
})

export const documentStyles = documentLayout()
export const noteDocumentStyles = documentLayout({ source: 'note' })
