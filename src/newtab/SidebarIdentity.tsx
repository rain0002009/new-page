import { Leaf } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'

const brand = tv({
  slots: {
    base: 'brand flex items-center gap-[10px] h-[40px] text-[23px] font-bold tracking-[2px] text-ui-ink',
    icon: 'w-[37px] h-[40px] shrink-0 text-[#657b52] rounded-[12px_12px_12px_3px] grid place-items-center bg-[linear-gradient(140deg,#f7ffec,#d4e4bf)] shadow-[inset_0_1px_1px_#fff,0_6px_16px_#768e4f18]',
    label: 'leading-[28px]',
    caption: 'block tracking-[2.3px] text-[7px] leading-[10px] font-medium text-[#98a18d]',
  },
  variants: { sidebar: {
    true: { base: 'pl-[9px] [@media(max-width:650px)]:pl-0 [@media(max-width:650px)]:h-[36px]', icon: '[@media(max-width:650px)]:w-[36px] [@media(max-width:650px)]:h-[36px] [@media(max-width:650px)]:m-auto', label: '[@media(max-width:650px)]:hidden' },
    false: { base: 'mb-[12px]' },
  } },
  defaultVariants: { sidebar: false },
})
const identity = tv({ slots: {
  brand: 'h-[40px] mb-[30px] [@media(max-width:1200px)]:mb-[28px] [@media(max-width:650px)]:h-[36px]',
  profile: 'flex items-center gap-[11px] px-[10px] mb-[24px] h-[36px] min-w-0 [@media(max-width:650px)]:hidden',
  avatar: 'grid place-items-center w-[36px] h-[36px] shrink-0 rounded-full border-[3px] border-solid border-[#fafbf5] bg-[linear-gradient(135deg,#faffef,#d9e6c8)] text-[#6e7c5e] text-[15px] [font-weight:650] shadow-[0_0_24px_#b4d28c38]',
  name: 'truncate text-[13px] font-semibold text-ui-ink',
} })
const styles = identity()

export function Brand({ sidebar = false }: { sidebar?: boolean }) {
  const styles = brand({ sidebar })
  return <div role="img" aria-label="页墟 Page Garden" className={styles.base()}><span className={styles.icon()}><Leaf size={22} strokeWidth={1.8} /></span><div className={styles.label()}>页墟<small className={styles.caption()}>PAGE GARDEN</small></div></div>
}

// The sidebar reserves the same flow space as the HTML scene behind it.
export function SidebarIdentity({ nickname, reserve = false }: { nickname: string; reserve?: boolean }) {
  return <div aria-hidden={reserve || undefined}>
    <div className={styles.brand()}>{!reserve && <Brand sidebar />}</div>
    <div role={reserve ? undefined : 'img'} aria-label={reserve ? undefined : `用户 ${nickname}`} className={styles.profile()}>
      {!reserve && nickname && <><span aria-hidden="true" className={styles.avatar()}>{Array.from(nickname)[0]}</span><span className={styles.name()} title={nickname}>{nickname}</span></>}
    </div>
  </div>
}
