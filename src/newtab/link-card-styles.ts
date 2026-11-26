import { tv } from 'tailwind-variants/lite'

export const linkCard = tv({
  slots: {
    base: 'link-card group/card relative min-w-0 [&:has([data-tag-menu-open])]:z-[1000] min-h-[104px] px-[16px] py-[14px] rounded-[12px] border border-solid border-[#ffffffb3] shadow-[0_3px_12px_#43503806] [transition:box-shadow_.2s,border-color_.2s,background_.2s] hover:border-[#c7d8b1] hover:shadow-[0_7px_18px_#4350380d]',
    top: 'min-h-[36px] text-[12px] [line-height:18px] line-clamp-2 [overflow-wrap:anywhere]',
    icon: 'absolute',
    actions: 'absolute top-[13px] right-[11px] z-[30] flex gap-[1px] rounded-[10px] bg-transparent transition-opacity duration-150 group-hover/card:bg-[#fafff1ed] group-focus-within/card:bg-ui-surface',
    title: 'block text-[14px] [font-weight:550] text-[#384730] leading-[1.7] [text-indent:calc(1.25rem+10px)] mt-[calc((1.4em-1.7em)/2)] after:content-empty after:absolute after:inset-0 after:rounded-[12px]',
    domain: 'block truncate text-[9px] tracking-[.2px] text-[#8f9c83] mt-[4px]',
    note: 'text-[12px] text-[#788071] mt-[6px] [line-height:17px] truncate min-h-[17px] empty:hidden',
    bottom: 'relative z-2 flex items-center justify-between mt-[5px] min-h-[15px] pointer-events-none',
    location: 'flex items-center gap-[4px] truncate text-[8px] text-[#9eaa92] min-w-0',
    secondary: 'ml-auto flex opacity-0 pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(max-width:650px)]:opacity-100',
  },
  defaultVariants: { note: false },
  variants: { search: { true: { base: 'cursor-default' } }, note: { true: { base: 'bg-[#f2e6cc] hover:bg-[#f6ebd4]' }, false: { base: 'bg-[#eaf0e2] hover:bg-[#e3ecd8]' } } },
})
