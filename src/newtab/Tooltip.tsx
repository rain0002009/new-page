import {
  cloneElement,
  isValidElement,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import {
  autoUpdate,
  flip as floatingFlip,
  FloatingPortal,
  offset as floatingOffset,
  shift as floatingShift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
  useTransitionStyles,
  type Placement,
} from '@floating-ui/react'
import { tv } from 'tailwind-variants/lite'
import { reducedMotion } from './motion'

const tooltipStyle = tv({
  base: 'z-50 pointer-events-none select-none rounded-[6px] bg-[#2a3526] px-[8px] py-[4px] text-[11px] leading-tight text-white shadow-[0_4px_14px_#1e2b1b33] whitespace-nowrap w-max',
})

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  placement?: Placement
  offset?: number
  disabled?: boolean
  className?: string
  style?: CSSProperties
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  offset: offsetPx = 6,
  disabled = false,
  className,
  style,
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const isEnabled = Boolean(content) && !disabled

  const middleware = useMemo(
    () => [
      floatingOffset(offsetPx),
      floatingFlip({ padding: 8 }),
      floatingShift({ padding: 8 }),
    ],
    [offsetPx]
  )

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isEnabled ? open : false,
    onOpenChange: setOpen,
    placement,
    strategy: 'fixed',
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware,
  })

  const hover = useHover(context, {
    enabled: isEnabled,
    move: false,
    delay: { open: 250, close: 0 },
  })
  const focus = useFocus(context, { enabled: isEnabled })
  const dismiss = useDismiss(context, {
    enabled: isEnabled,
    escapeKey: true,
    referencePress: true,
  })
  const role = useRole(context, { role: 'tooltip' })

  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
  ])

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: reducedMotion() ? 0 : 150,
    common: ({ side }) => ({
      transformOrigin: {
        top: 'bottom center',
        bottom: 'top center',
        left: 'right center',
        right: 'left center',
      }[side],
    }),
    initial: {
      opacity: 0,
      transform: 'scale(0.96)',
    },
    open: {
      opacity: 1,
      transform: 'scale(1)',
    },
    close: {
      opacity: 0,
      transform: 'scale(0.96)',
    },
  })

  const childRef = isValidElement(children)
    ? (children as unknown as { ref?: Ref<unknown> }).ref
    : undefined
  const mergedRef = useMergeRefs([refs.setReference, childRef])

  const triggerElement = isValidElement(children) ? (
    (() => {
      const childProps = (children.props as Record<string, unknown>) || {}
      const { title: _ignoredTitle, onKeyDown: childOnKeyDown, ...restProps } = childProps
      const interactionProps = getReferenceProps({
        ...restProps,
        onKeyDown(event: KeyboardEvent) {
          if (event.key === 'Enter' || event.key === ' ') {
            setOpen(false)
          }
          if (typeof childOnKeyDown === 'function') {
            childOnKeyDown(event)
          }
        },
      })
      return cloneElement(children, {
        ref: mergedRef,
        title: undefined,
        ...interactionProps,
      })
    })()
  ) : (
    <span ref={refs.setReference} {...getReferenceProps()}>
      {children}
    </span>
  )

  return (
    <>
      {triggerElement}
      {isMounted && isEnabled && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              ...transitionStyles,
              visibility: isPositioned ? undefined : 'hidden',
              ...style,
            }}
            className={tooltipStyle({ className })}
            {...getFloatingProps()}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
