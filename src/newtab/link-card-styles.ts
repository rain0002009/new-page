import { tv } from 'tailwind-variants/lite'

export const linkCard = tv({
  slots: {
    base: 'link-card group/card relative min-w-0 min-h-[124px] px-[17px] pt-[17px] pb-[15px] rounded-[15px] bg-[#fffffb8c] border border-solid border-[#ffffffb3] shadow-[0_3px_12px_#43503806] [transition:box-shadow_.2s,border-color_.2s,background_.2s] hover:bg-[#fffffbd1] hover:border-[#c7d8b1] hover:shadow-[0_7px_18px_#4350380d] before:content-empty before:absolute before:top-0 before:left-[12%] before:right-[12%] before:h-[1px] before:bg-[linear-gradient(90deg,transparent,#fff,transparent)]',
    top: 'flex justify-between items-center mb-[12px]',
    actions: 'absolute top-[13px] right-[11px] z-2 flex gap-[1px] rounded-[10px] bg-transparent transition-opacity duration-150 group-hover/card:bg-[#fafff1ed] group-focus-within/card:bg-ui-surface',
    title: 'block truncate text-[13px] [font-weight:550] text-[#384730] after:content-empty after:absolute after:inset-0 after:rounded-[12px]',
    domain: 'block truncate text-[9px] tracking-[.2px] text-[#8f9c83] mt-[4px]',
    note: 'text-[11px] text-[#7c8871] mt-[11px] [line-height:1.8] line-clamp-2 min-h-[18px] whitespace-pre-wrap empty:hidden',
    bottom: 'relative z-2 flex items-center justify-between mt-[5px] min-h-[15px] pointer-events-none',
    location: 'flex items-center gap-[4px] truncate text-[8px] text-[#9eaa92] min-w-0',
    secondary: 'ml-auto flex opacity-0 pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(max-width:650px)]:opacity-100',
  },
  variants: { search: { true: { base: 'cursor-default' } } },
})
