import { tv } from 'tailwind-variants/lite'

const documentLayout = tv({
  slots: {
    main: 'relative z-1 mx-auto flex w-full min-h-dvh flex-col gap-[16px] px-[28px] py-[24px] [@media(max-width:650px)]:px-[16px] [@media(max-width:650px)]:py-[16px]',
    header: 'flex flex-wrap items-center justify-end gap-[12px] text-ui-sage',
    status: 'm-0 mr-auto text-[11px] text-ui-muted',
    columns: 'grid flex-1 grid-cols-[190px_minmax(0,1fr)] gap-[24px] [@media(max-width:650px)]:grid-cols-1 [@media(max-width:650px)]:grid-rows-[auto_1fr] [@media(max-width:650px)]:gap-[16px]',
    sidebar: 'min-w-0',
    surface: 'flex min-w-0 flex-col gap-[12px] rounded-[22px] bg-ui-surface border border-solid border-white p-[28px] [@media(max-width:650px)]:p-[16px]',
    title: 'block w-full text-[32px] leading-[1.3] font-semibold border-0 bg-transparent px-[8px] py-[4px] m-0 focus:outline-none',
    conflict: 'rounded-[12px] bg-action-danger-surface p-[16px] text-action-danger [overflow-wrap:anywhere]',
  },
  variants: { source: { note: { main: 'max-w-[1600px]' }, file: { main: 'max-w-[1600px]' } } },
  defaultVariants: { source: 'file' },
})

export const documentStyles = documentLayout()
export const noteDocumentStyles = documentLayout({ source: 'note' })
