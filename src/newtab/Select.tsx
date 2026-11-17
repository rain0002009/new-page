import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react'
import 'overlayscrollbars/overlayscrollbars.css'
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
  size?: 'compact' | 'control'
  placeholder?: string
}

const selectStyles = tv({
  slots: {
    container: 'relative',
    trigger:
      'flex items-center justify-between cursor-pointer focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ui-focus transition-colors select-none shrink-0 whitespace-nowrap',
    menu: 'z-30 min-w-full w-max bg-white rounded-[8px] border border-solid border-[#d7e2cc] shadow-[0_8px_24px_#334c2b22] select-none overflow-hidden',
    scroll:
      'w-full max-h-[160px] [&_[data-overlayscrollbars-viewport]]:max-h-[160px] [&_[data-overlayscrollbars-viewport]]:overscroll-contain',
    scrollbar:
      'os-theme-garden [--os-size:7px] [--os-padding-perpendicular:2px] [--os-padding-axis:4px] [--os-track-border-radius:99px] [--os-handle-border-radius:99px] [--os-handle-bg:#70856059] [--os-handle-bg-hover:#617b50a6] [--os-handle-bg-active:#526c43d9] [--os-handle-min-size:20px] [&.os-scrollbar-vertical]:right-[2px] [&_.os-scrollbar-handle]:shadow-[inset_0_0_0_1px_#ffffff45] [&_.os-scrollbar-handle]:[transition:background-color_.18s,box-shadow_.18s]',
    option:
      'w-full text-left border-0 transition-colors cursor-pointer block whitespace-nowrap',
  },
  variants: {
    size: {
      compact: {
        container: 'inline-block',
        trigger:
          'gap-[5px] px-[8px] py-[3px] text-[12px] font-semibold text-ui-ink bg-[#f5f8ef] border border-solid border-[#dce4d2] rounded-[6px] hover:border-[#a8bc94]',
        option: 'px-[8px] py-[4px] text-[12px] rounded-[5px]',
        scroll: 'max-h-[160px] [&_[data-overlayscrollbars-viewport]]:max-h-[160px]',
      },
      control: {
        container: 'block w-full',
        trigger:
          'w-full gap-[8px] px-[12px] py-[8px] min-h-[38px] text-[12px] text-form-ink bg-form-surface border border-solid border-form-line rounded-[8px] hover:border-[#a8bc94]',
        option: 'px-[10px] py-[7px] text-[12px] rounded-[6px]',
        scroll: 'max-h-[180px] [&_[data-overlayscrollbars-viewport]]:max-h-[180px]',
      },
    },
  },
  defaultVariants: {
    size: 'compact',
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
  size = 'compact',
  placeholder,
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
    matchReferenceWidth: true,
  })

  const selectedOption = options.find(opt => opt.value === value)
  const styles = selectStyles({ size })

  const triggerOpenClass = isOpen
    ? size === 'control'
      ? 'border-form-focus shadow-[0_0_0_3px_#eaf0df]'
      : 'border-[#82996a] shadow-[0_0_0_2px_#82996a22]'
    : ''

  // Scroll active option into view when opened
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return
    const raf = requestAnimationFrame(() => {
      const activeEl = menuRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' })
      }
    })
    return () => cancelAnimationFrame(raf)
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
        className={`${styles.trigger()} ${triggerOpenClass} ${
          disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
        }`}
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
        <span className={selectedOption ? '' : 'text-form-placeholder'}>
          {selectedOption ? selectedOption.label : placeholder || ''}
        </span>
        <ChevronDown
          size={size === 'control' ? 14 : 12}
          className={`text-[#788869] transition-transform duration-150 shrink-0 ${isOpen ? 'rotate-180' : ''}`}
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
          <OverlayScrollbarsComponent
            className={styles.scroll()}
            data-overlayscrollbars-initialize
            options={{
              overflow: { x: 'hidden', y: 'scroll' },
              scrollbars: {
                theme: styles.scrollbar(),
                autoHide: 'leave',
                autoHideDelay: 300,
                clickScroll: 'instant',
              },
            }}
          >
            <div className={size === 'control' ? 'p-[4px] space-y-[2px]' : 'p-[3px] space-y-[1px]'}>
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
          </OverlayScrollbarsComponent>
        </div>
      )}
    </div>
  )
}
