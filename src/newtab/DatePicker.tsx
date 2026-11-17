import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { tv } from 'tailwind-variants/lite'
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Select } from './Select'
import { usePopover } from './popover'

const pillStyles = tv({
  base: 'px-[10px] py-[5px] text-[11px] rounded-[6px] border border-solid transition-colors cursor-pointer',
  variants: {
    active: {
      true: 'bg-[#edf3e4] border-[#8ea476] text-[#485d38] font-semibold',
      false: 'bg-form-surface border-form-line text-[#707c64] hover:bg-[#f0f4ea]',
    },
  },
  defaultVariants: { active: false },
})

export function DatePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: number | null | undefined
  onChange: (value: number | null) => void
  disabled?: boolean
}) {
  const [customMode, setCustomMode] = useState(() => Boolean(value))
  const [isOpen, setIsOpen] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const popover = usePopover({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    offset: 6,
    role: 'dialog',
    enabled: !disabled,
  })

  // Calendar view year and month (0-indexed)
  const initialDate = value ? dayjs.unix(value) : dayjs()
  const [viewYear, setViewYear] = useState(() => initialDate.year())
  const [viewMonth, setViewMonth] = useState(() => initialDate.month())

  // Keep view aligned when value changes externally or dropdown opens
  useEffect(() => {
    if (value) {
      const d = dayjs.unix(value)
      setViewYear(d.year())
      setViewMonth(d.month())
    } else {
      const now = dayjs()
      setViewYear(now.year())
      setViewMonth(now.month())
    }
  }, [value, isOpen])

  const currentDateStr = value ? dayjs.unix(value).format('YYYY-MM-DD') : ''

  function clearCustomDate() {
    onChange(null)
    setIsOpen(false)
  }

  function selectPreset(days: number | null) {
    if (days === null) {
      setCustomMode(false)
      setIsOpen(false)
      onChange(null)
    } else {
      setCustomMode(false)
      setIsOpen(false)
      const timestamp = dayjs().add(days, 'day').endOf('day').unix()
      onChange(timestamp)
    }
  }

  function prevMonth() {
    if (viewMonth === 0) {
      setViewYear(y => y - 1)
      setViewMonth(11)
    } else {
      setViewMonth(m => m - 1)
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewYear(y => y + 1)
      setViewMonth(0)
    } else {
      setViewMonth(m => m + 1)
    }
  }

  // Determine active preset
  const isPermanent = !value
  const diffDays = value ? Math.round((value - dayjs().unix()) / 86400) : null
  const is1Day = !customMode && diffDays === 1
  const is7Days = !customMode && (diffDays === 7 || diffDays === 6)
  const is30Days = !customMode && (diffDays === 30 || diffDays === 29)
  const isCustom = !isPermanent && !is1Day && !is7Days && !is30Days

  // Year & Month options
  const currentYear = dayjs().year()
  const yearOptions = Array.from({ length: 12 }, (_, i) => {
    const y = currentYear - 1 + i
    return { value: y, label: `${y}年` }
  })
  const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
  const monthOptions = monthNames.map((m, idx) => ({ value: idx, label: m }))

  // Days in month calculation
  const firstDayOfMonth = dayjs(new Date(viewYear, viewMonth, 1))
  const daysInMonth = firstDayOfMonth.daysInMonth()
  const startDayOfWeek = (firstDayOfMonth.day() + 6) % 7 // Monday = 0, Sunday = 6
  const today = dayjs()
  const selectedDayjs = value ? dayjs.unix(value) : null

  // Requirement 4: Mutual exclusion between clear icon and calendar icon
  const showClear = Boolean(value && !disabled && isHovered)

  return (
    <div className="relative space-y-[8px]">
      <div className="flex flex-wrap items-center gap-[6px]">
        <button
          type="button"
          disabled={disabled}
          className={pillStyles({ active: isPermanent })}
          onClick={() => selectPreset(null)}
        >
          永久有效
        </button>
        <button
          type="button"
          disabled={disabled}
          className={pillStyles({ active: is1Day })}
          onClick={() => selectPreset(1)}
        >
          1天后
        </button>
        <button
          type="button"
          disabled={disabled}
          className={pillStyles({ active: is7Days })}
          onClick={() => selectPreset(7)}
        >
          7天后
        </button>
        <button
          type="button"
          disabled={disabled}
          className={pillStyles({ active: is30Days })}
          onClick={() => selectPreset(30)}
        >
          30天后
        </button>
        <button
          type="button"
          disabled={disabled}
          className={pillStyles({ active: isCustom || customMode })}
          onClick={() => {
            setCustomMode(true)
            setIsOpen(true)
          }}
        >
          <Calendar size={12} className="inline mr-[4px]" />
          指定日期
        </button>
      </div>

      {(customMode || isCustom || !!value) && (
        <div className="relative pt-[2px]">
          {/* Trigger Box: Clicking anywhere opens dropdown, no manual keyboard editing */}
          <div
            role="button"
            ref={popover.refs.setReference}
            tabIndex={disabled ? -1 : 0}
            aria-label="选择具体过期日期"
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            className={`flex items-center justify-between w-full rounded-[9px] border border-solid bg-form-surface px-[10px] py-[7px] text-[12px] transition-colors select-none ${
              disabled
                ? 'opacity-50 cursor-not-allowed border-form-line'
                : 'cursor-pointer hover:border-[#96ab80] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ui-focus'
            } ${isOpen ? 'border-[#82996a] shadow-[0_0_0_2px_#82996a22]' : 'border-form-line'}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={() => {
              if (!disabled) setIsOpen(open => !open)
            }}
            onKeyDown={e => {
              if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                setIsOpen(open => !open)
              }
            }}
            {...popover.getReferenceProps()}
          >
            <span className={currentDateStr ? 'font-mono text-ui-ink font-medium' : 'text-[#9aa490]'}>
              {currentDateStr || '点击选择过期日期…'}
            </span>

            {/* Mutually exclusive icon */}
            <div className="flex items-center text-[#788869]">
              {showClear ? (
                <button
                  type="button"
                  aria-label="清除日期"
                  title="清除为永久有效"
                  className="flex items-center justify-center p-[2px] rounded-[4px] hover:bg-[#e4ebd7] hover:text-[#4a5e38] text-[#788869] border-0 bg-transparent cursor-pointer transition-colors"
                  onClick={e => {
                    e.stopPropagation()
                    clearCustomDate()
                  }}
                >
                  <X size={14} />
                </button>
              ) : (
                <Calendar size={14} />
              )}
            </div>
          </div>

          {/* Calendar Dropdown Popup */}
          {isOpen && (
            <div
              role="dialog"
              ref={popover.refs.setFloating}
              style={popover.floatingStyles}
              aria-label="日期选择日历"
              className="z-50 w-[274px] p-[12px] bg-white rounded-[14px] border border-solid border-[#d7e2cc] shadow-[0_12px_36px_#334c2b26] select-none"
              {...popover.getFloatingProps()}
            >
              {/* Header: ChevronLeft, Year select, Month select, ChevronRight */}
              <div className="flex items-center justify-between mb-[10px]">
                <button
                  type="button"
                  aria-label="上个月"
                  title="上个月"
                  className="w-[26px] h-[26px] rounded-[6px] flex items-center justify-center text-[#687a57] hover:bg-[#edf3e4] hover:text-[#425530] border-0 bg-transparent cursor-pointer transition-colors"
                  onClick={prevMonth}
                >
                  <ChevronLeft size={16} />
                </button>

                <div className="flex items-center gap-[6px]">
                  <Select
                    label="选择年份"
                    value={viewYear}
                    options={yearOptions}
                    onChange={setViewYear}
                  />
                  <Select
                    label="选择月份"
                    value={viewMonth}
                    options={monthOptions}
                    onChange={setViewMonth}
                  />
                </div>

                <button
                  type="button"
                  aria-label="下个月"
                  title="下个月"
                  className="w-[26px] h-[26px] rounded-[6px] flex items-center justify-center text-[#687a57] hover:bg-[#edf3e4] hover:text-[#425530] border-0 bg-transparent cursor-pointer transition-colors"
                  onClick={nextMonth}
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Weekdays header */}
              <div className="grid grid-cols-7 text-center mb-[4px]">
                {['一', '二', '三', '四', '五', '六', '日'].map(weekday => (
                  <span key={weekday} className="text-[11px] font-medium text-[#8c997e] py-[2px]">
                    {weekday}
                  </span>
                ))}
              </div>

              {/* Days grid */}
              <div className="grid grid-cols-7 gap-y-[3px] gap-x-[2px]">
                {Array.from({ length: startDayOfWeek }).map((_, i) => (
                  <div key={`empty-${i}`} className="w-[34px] h-[30px]" />
                ))}

                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
                  const date = dayjs(new Date(viewYear, viewMonth, day))
                  const isPast = date.isBefore(today, 'day')
                  const isSelected = selectedDayjs ? date.isSame(selectedDayjs, 'day') : false
                  const isToday = date.isSame(today, 'day')

                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={isPast || disabled}
                      aria-label={`${date.format('YYYY年M月D日')}${isSelected ? '（已选）' : isToday ? '（今天）' : ''}`}
                      aria-selected={isSelected}
                      className={`w-[34px] h-[30px] mx-auto text-[12px] flex items-center justify-center rounded-[8px] border-0 transition-colors relative ${
                        isSelected
                          ? 'bg-[#65814e] text-white font-semibold shadow-[0_2px_6px_#4b633633] cursor-pointer'
                          : isPast
                          ? 'text-[#cdd6c3] cursor-not-allowed bg-transparent'
                          : isToday
                          ? 'text-[#4c6736] font-semibold hover:bg-[#edf3e4] cursor-pointer bg-transparent'
                          : 'text-ui-ink hover:bg-[#edf3e4] hover:text-[#435930] cursor-pointer bg-transparent'
                      }`}
                      onClick={() => {
                        if (!isPast && !disabled) {
                          onChange(date.endOf('day').unix())
                          setIsOpen(false)
                        }
                      }}
                    >
                      <span>{day}</span>
                      {isToday && !isSelected && (
                        <span className="absolute bottom-[2px] left-1/2 -translate-x-1/2 w-[3px] h-[3px] rounded-full bg-[#65814e]" />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {value && (
        <p className="text-[10px] text-[#829074] m-0">
          将在 {dayjs.unix(value).format('YYYY年M月D日 23:59:59')} 自动失效
        </p>
      )}
    </div>
  )
}
