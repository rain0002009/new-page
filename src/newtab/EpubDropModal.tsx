import { useState } from 'react'
import { BookOpen, CloudUpload, HardDrive } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { Button, Modal } from './ui'
import { feedbackStyles } from './form-styles'

export type EpubModeChoice = 'local' | 'quark'

const optionCard = tv({
  base: 'flex items-start gap-[12px] rounded-[12px] border border-solid p-[12px] text-left transition-colors',
  variants: {
    selected: {
      true: 'bg-[#e4ecf2] border-[#6b8aa3] cursor-pointer',
      false: 'bg-[#f7f8f2] border-form-line hover:bg-[#eff3ec] cursor-pointer',
    },
    disabled: {
      true: 'bg-[#f5f6f0] border-form-line opacity-60 cursor-not-allowed hover:bg-[#f5f6f0]',
      false: '',
    },
  },
  defaultVariants: { selected: false, disabled: false },
})

export function EpubDropModal({
  fileNames,
  quarkConnected,
  fallbackReason,
  busy,
  onConfirm,
  onClose,
}: {
  fileNames: string[]
  quarkConnected: boolean
  fallbackReason?: string
  busy: boolean
  onConfirm: (mode: EpubModeChoice, remember: boolean) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<EpubModeChoice>('local')
  const [remember, setRemember] = useState(false)

  const summary = fileNames.length === 1
    ? `即将添加「${fileNames[0].replace(/\.epub$/i, '')}」`
    : `即将批量添加 ${fileNames.length} 本电子书`

  return (
    <Modal title="选择电子书保存与阅读方式" close={() => { if (!busy) onClose() }}>
      <p className="m-0 text-[13px] text-ui-ink [overflow-wrap:anywhere]">{summary}</p>
      {fallbackReason && (
        <p className={`${feedbackStyles.muted()} mt-[8px] text-[#a66756]`}>{fallbackReason}</p>
      )}

      <div className="mt-[16px] flex flex-col gap-[10px]" role="radiogroup" aria-label="电子书保存方式">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'local'}
          disabled={busy}
          className={optionCard({ selected: mode === 'local', disabled: busy })}
          onClick={() => setMode('local')}
        >
          <span className="mt-[2px] grid h-[28px] w-[28px] shrink-0 place-items-center rounded-[8px] bg-[#d6e2ec] text-[#4c6b85]">
            <HardDrive size={15} />
          </span>
          <span className="min-w-0">
            <strong className="block text-[13px] font-semibold text-[#303b2c]">本地阅读（仅保存在本机）</strong>
            <span className="mt-[3px] block text-[11px] leading-[1.5] text-ui-muted">
              不上传网盘，浏览器内直接离线打开，原文件移动或删除后仍可阅读
            </span>
          </span>
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={mode === 'quark'}
          disabled={busy || !quarkConnected}
          className={optionCard({ selected: mode === 'quark', disabled: busy || !quarkConnected })}
          onClick={() => { if (quarkConnected) setMode('quark') }}
        >
          <span className="mt-[2px] grid h-[28px] w-[28px] shrink-0 place-items-center rounded-[8px] bg-[#d6e2ec] text-[#4c6b85]">
            <CloudUpload size={15} />
          </span>
          <span className="min-w-0">
            <strong className="block text-[13px] font-semibold text-[#303b2c]">上传到夸克网盘</strong>
            <span className="mt-[3px] block text-[11px] leading-[1.5] text-ui-muted">
              {quarkConnected
                ? '保存到「页墟收藏/电子书」并缓存本机，支持跨设备同步阅读'
                : '需先在设置中连接夸克网盘后才可使用'}
            </span>
          </span>
        </button>
      </div>

      <label className="mt-[16px] flex items-center gap-[8px] text-[12px] text-ui-ink cursor-pointer select-none">
        <input
          type="checkbox"
          checked={remember}
          disabled={busy}
          onChange={event => setRemember(event.target.checked)}
        />
        <span>记住我的选择，下次不再询问（可在设置中修改）</span>
      </label>

      <div className="mt-[22px] flex justify-end gap-[8px]">
        <Button disabled={busy} onClick={onClose}>取消</Button>
        <Button tone="primary" disabled={busy} onClick={() => onConfirm(mode, remember)}>
          <BookOpen size={15} />
          {busy ? '正在处理…' : '确认添加'}
        </Button>
      </div>
    </Modal>
  )
}
