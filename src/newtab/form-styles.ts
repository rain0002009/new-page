import { tv } from 'tailwind-variants/lite'

const label = 'block min-w-0 [font-weight:550] text-form-label'

export const formStyles = tv({
  slots: {
    label,
    rowLabel: label,
    control: 'w-full block mt-[7px] bg-form-surface border border-solid border-form-line rounded-[8px] text-form-ink text-[12px] transition-[border-color] duration-150 placeholder:text-form-placeholder placeholder:text-[11px] focus:border-form-focus focus:outline-none focus:shadow-[0_0_0_3px_#eaf0df]',
    row: 'grid gap-[14px] [@media(max-width:650px)]:gap-0',
    fieldset: 'border border-solid border-ui-line p-[14px] rounded-[9px]',
    legend: 'text-[10px] text-[#88977b]',
    radioLabel: 'flex items-center gap-[6px] text-[11px] [font-weight:550] text-form-label my-[5px] flex-wrap',
    radio: 'accent-ui-sage focus:border-form-focus focus:outline-none focus:shadow-[0_0_0_3px_#eaf0df]',
    radioHint: 'text-[9px] text-[#a3ad97] ml-[20px]',
  },
  variants: { onboarding: {
    true: { label: 'text-[10px] mb-[16px]', rowLabel: 'text-[10px] mb-[12px]', control: 'p-[13px]', row: 'grid-cols-1' },
    false: { label: 'text-[11px] mb-[16px]', rowLabel: 'text-[11px] mb-[16px]', control: 'py-[11px] px-[12px]', row: 'grid-cols-2 [@media(max-width:650px)]:grid-cols-1' },
  } },
  defaultVariants: { onboarding: false },
})

const feedback = tv({
  slots: {
    alert: 'py-[13px] px-[16px] bg-[#fff1e4] text-[#9d724f] border border-solid border-[#eedec6] rounded-[9px] flex items-center justify-between gap-[12px] text-[12px] my-[16px] [overflow-wrap:anywhere]',
    error: 'text-[11px] text-[#b27b5e] my-[8px]',
    muted: 'text-ui-muted text-[13px]',
    confirmation: 'p-[14px] bg-[#f1f4e9] rounded-[10px]',
    confirmationText: 'text-[12px] mb-[12px]',
  },
})
export const feedbackStyles = feedback()
