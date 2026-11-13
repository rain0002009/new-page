import { useId } from 'react'

export default function Switch({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return <label htmlFor={id} className={`flex items-center justify-between gap-[16px] min-h-[36px] text-[11px] text-form-label ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
    <span>{label}</span>
    <span className="relative shrink-0">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="peer absolute inset-0 z-1 w-full h-full m-0 cursor-inherit opacity-0" />
      <span aria-hidden="true" className="block relative w-[40px] h-[24px] rounded-full bg-[#cbd3c2] transition-colors duration-150 peer-checked:bg-ui-sage peer-focus-visible:outline-2 peer-focus-visible:outline-ui-focus peer-focus-visible:outline-offset-3 peer-disabled:opacity-50 after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:w-[18px] after:h-[18px] after:bg-white after:rounded-full after:shadow-[0_1px_3px_#303b2c33] after:transition-transform after:duration-150 peer-checked:after:translate-x-[16px] motion-reduce:transition-none motion-reduce:after:transition-none" />
    </span>
  </label>
}
