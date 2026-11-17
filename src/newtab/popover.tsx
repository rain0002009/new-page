import {
  cloneElement,
  isValidElement,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  autoUpdate,
  flip as floatingFlip,
  offset as floatingOffset,
  shift as floatingShift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type Placement,
} from '@floating-ui/react'

export interface UsePopoverOptions {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: Placement
  offset?: number
  role?: 'dialog' | 'listbox' | 'menu' | 'tooltip'
  enabled?: boolean
}

export function usePopover({
  open: controlledOpen,
  onOpenChange: setControlledOpen,
  placement = 'bottom-start',
  offset: offsetPx = 6,
  role: roleName = 'dialog',
  enabled = true,
}: UsePopoverOptions = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = setControlledOpen ?? setUncontrolledOpen

  const middleware = useMemo(
    () => [
      floatingOffset(offsetPx),
      floatingFlip({ fallbackAxisSideDirection: 'start', padding: 8 }),
      floatingShift({ padding: 8 }),
    ],
    [offsetPx]
  )

  const data = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware,
  })

  const dismiss = useDismiss(data.context, {
    enabled,
    escapeKey: true,
    outsidePress: true,
  })

  const role = useRole(data.context, { role: roleName })

  const interactions = useInteractions([dismiss, role])

  return useMemo(
    () => ({
      open,
      setOpen,
      ...interactions,
      ...data,
    }),
    [open, setOpen, interactions, data]
  )
}

export interface PopoverProps extends UsePopoverOptions {
  trigger: ReactNode | ((props: Record<string, unknown>) => ReactNode)
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function Popover({
  trigger,
  children,
  className,
  style,
  ...options
}: PopoverProps) {
  const popover = usePopover(options)

  const triggerProps = {
    ref: popover.refs.setReference,
    ...popover.getReferenceProps(),
  }

  return (
    <>
      {typeof trigger === 'function' ? (
        trigger(triggerProps)
      ) : isValidElement(trigger) ? (
        cloneElement(trigger, {
          ref: popover.refs.setReference,
          ...popover.getReferenceProps(trigger.props as Record<string, unknown>),
        })
      ) : (
        <span ref={popover.refs.setReference} {...popover.getReferenceProps()}>
          {trigger}
        </span>
      )}

      {popover.open && (
        <div
          ref={popover.refs.setFloating}
          style={{
            ...popover.floatingStyles,
            ...style,
          }}
          className={`z-50 ${className || ''}`}
          {...popover.getFloatingProps()}
        >
          {children}
        </div>
      )}
    </>
  )
}
