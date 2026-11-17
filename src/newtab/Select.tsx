import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { usePopover } from './popover'

export interface SelectOption<T = string | number> {
  value: T
  label: string
}

export interface SelectProps<T = string | number> {
  id?: string
  label: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}

const selectStyles = tv({
  slots: {
    container: 'relative inline-block',
    trigger:
      'flex items-center justify-between gap-[5px] px-[8px] py-[3px] text-[12px] font-semibold text-ui-ink bg-[#f5f8ef] border border-solid border-[#dce4d2] rounded-[6px] cursor-pointer hover:border-[#a8bc94] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ui-focus transition-colors select-none',
    menu: 'z-30 min-w-full max-h-[160px] overflow-y-auto bg-white rounded-[8px] border border-solid border-[#d7e2cc] shadow-[0_6px_20px_#334c2b22] p-[3px] space-y-[1px] select-none',
    option:
      'w-full text-left px-[8px] py-[4px] text-[12px] rounded-[5px] border-0 transition-colors cursor-pointer block',
  },
  variants: {
    isOpen: {
      true: {
        trigger: 'border-[#82996a] shadow-[0_0_0_2px_#82996a22]',
      },
    },
  },
})

export function Select<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: SelectProps<T>) {
  const generatedId = useId()
  const selectId = id || generatedId
  const listboxId = `${selectId}-listbox`
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const popover = usePopover({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    offset: 4,
    role: 'listbox',
    enabled: !disabled,
  })

  const selectedOption = options.find(opt => opt.value === value)
  const styles = selectStyles({ isOpen })

  // Scroll active option into view when opened
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return
    const activeEl = menuRef.current.querySelector('[aria-selected="true"]') as HTMLElement | null
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [isOpen])

  return (
    <div className={`${styles.container()} ${className || ''}`}>
      <button
        id={selectId}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        disabled={disabled}
        ref={popover.refs.setReference}
        className={styles.trigger()}
        onClick={() => {
          if (!disabled) setIsOpen(open => !open)
        }}
        onKeyDown={e => {
          if (disabled) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setIsOpen(true)
          }
        }}
        {...popover.getReferenceProps()}
      >
        <span>{selectedOption ? selectedOption.label : ''}</span>
        <ChevronDown
          size={12}
          className={`text-[#788869] transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          ref={node => {
            popover.refs.setFloating(node)
            menuRef.current = node
          }}
          style={popover.floatingStyles}
          className={styles.menu()}
          {...popover.getFloatingProps()}
        >
          {options.map(option => {
            const isSelected = option.value === value
            return (
              <button
                key={String(option.value)}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`${styles.option()} ${
                  isSelected
                    ? 'bg-[#65814e] text-white font-semibold'
                    : 'text-ui-ink bg-transparent hover:bg-[#edf3e4] hover:text-[#435930]'
                }`}
                onClick={() => {
                  onChange(option.value)
                  setIsOpen(false)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
