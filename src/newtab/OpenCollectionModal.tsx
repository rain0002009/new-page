import { useState } from 'react'
import { Modal, Button, Tooltip } from './ui'
import { formStyles } from './form-styles'
import type { Collection } from '../core/model'

export type OpenCollectionStrategy = 'keep' | 'collapse' | 'clear'

const options = [
  { value: 'keep' as const, label: '保留', hint: '不改变现有页面，在后方依次打开新标签页' },
  { value: 'collapse' as const, label: '收拢', hint: '将当前窗口未分组的标签页收入折叠分组，并收起现有分组' },
  { value: 'clear' as const, label: '清空', hint: '关闭当前窗口已打开的所有页面，仅保留新打开的内容' },
]

export function OpenCollectionModal({
  collection,
  itemCount,
  close,
  onConfirm,
}: {
  collection: Collection
  itemCount: number
  close: () => void
  onConfirm: (strategy: OpenCollectionStrategy) => Promise<void> | void
}) {
  const [strategy, setStrategy] = useState<OpenCollectionStrategy>('keep')
  const [busy, setBusy] = useState(false)
  const fields = formStyles()

  const handleConfirm = async () => {
    setBusy(true)
    try {
      await onConfirm(strategy)
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="载入收藏块" close={close}>
      <div>
        <p className="text-[13px] text-[#414d38] mb-[16px] leading-[1.6]">
          即将依次打开「{collection.title}」下的所有网页与笔记（共 {itemCount} 项）。请选择如何处理当前窗口中已打开的标签页：
        </p>
        <fieldset className={fields.fieldset({ className: 'mt-0 mb-[20px] flex flex-col gap-[6px]' })}>
          <legend className={fields.legend()}>现有标签页处理策略</legend>
          {options.map(opt => (
            <Tooltip key={opt.value} content={opt.hint}>
              <label className={fields.radioLabel({ className: 'cursor-pointer select-none py-[4px] my-0' })}>
                <input
                  type="radio"
                  name="open-collection-strategy"
                  className={fields.radio()}
                  checked={strategy === opt.value}
                  onChange={() => setStrategy(opt.value)}
                  disabled={busy}
                />
                <span>{opt.label}</span>
              </label>
            </Tooltip>
          ))}
        </fieldset>
        <div className="flex justify-end gap-[8px] mt-[20px]">
          <Button disabled={busy} onClick={close}>取消</Button>
          <Button tone="primary" disabled={busy} onClick={() => void handleConfirm()}>确认</Button>
        </div>
      </div>
    </Modal>
  )
}
