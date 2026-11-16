import { useState, useId } from 'react'
import dayjs from 'dayjs'
import { tv } from 'tailwind-variants/lite'
import { X, Calendar } from 'lucide-react'
import { Button } from './ui'
import { formStyles } from './form-styles'

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

const fields = formStyles()

export function DatePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: number | null | undefined
  onChange: (value: number | null) => void
  disabled?: boolean
}) {
  const inputId = useId()
  const [customMode, setCustomMode] = useState(() => {
    if (!value) return false
    // If not matching 1, 7, or 30 days roughly, open custom mode
    return true
  })

  const todayStr = dayjs().format('YYYY-MM-DD')
  const currentDateStr = value ? dayjs.unix(value).format('YYYY-MM-DD') : ''

  function selectPreset(days: number | null) {
    if (days === null) {
      setCustomMode(false)
      onChange(null)
    } else {
      setCustomMode(false)
      const timestamp = dayjs().add(days, 'day').endOf('day').unix()
      onChange(timestamp)
    }
  }

  function handleDateInput(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    if (!val) {
      onChange(null)
    } else {
      const timestamp = dayjs(val).endOf('day').unix()
      onChange(timestamp)
    }
  }

  // Determine active preset
  const isPermanent = !value
  const diffDays = value ? Math.round((value - dayjs().unix()) / 86400) : null
  const is1Day = !customMode && diffDays === 1
  const is7Days = !customMode && (diffDays === 7 || diffDays === 6)
  const is30Days = !customMode && (diffDays === 30 || diffDays === 29)
  const isCustom = !isPermanent && !is1Day && !is7Days && !is30Days

  return (
    <div className="space-y-[8px]">
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
          onClick={() => setCustomMode(true)}
        >
          <Calendar size={12} className="inline mr-[4px]" />
          指定日期
        </button>
      </div>

      {(customMode || isCustom || !!value) && (
        <div className="flex items-center gap-[8px] pt-[2px]">
          <input
            id={inputId}
            type="date"
            min={todayStr}
            value={currentDateStr}
            disabled={disabled}
            aria-label="选择具体过期日期"
            className={fields.control({ className: 'mt-0 py-[7px] px-[10px] text-[12px]' })}
            onChange={handleDateInput}
          />
          {value && (
            <Button
              size="icon"
              disabled={disabled}
              aria-label="清除过期时间"
              title="清除为永久有效"
              onClick={() => selectPreset(null)}
            >
              <X size={15} />
            </Button>
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
