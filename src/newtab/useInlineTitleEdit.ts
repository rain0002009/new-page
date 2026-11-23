import { useEffect, useRef, useState } from 'react'

export interface InlineEditOptions {
  title: string
  isEditing?: boolean
  isNew?: boolean
  scrollIntoView?: boolean
  onSave: (trimmed: string) => Promise<void> | void
  onCancelNew?: () => Promise<void> | void
  onEndEdit?: () => void
}

export function useInlineTitleEdit({
  title,
  isEditing = false,
  isNew = false,
  scrollIntoView = false,
  onSave,
  onCancelNew,
  onEndEdit,
}: InlineEditOptions) {
  const [editingTitle, setEditingTitle] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing) {
      setEditingTitle(title)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
        if (scrollIntoView) {
          inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      })
    }
  }, [isEditing, title, scrollIntoView])

  const saveTitle = async () => {
    const trimmed = editingTitle.trim()
    if (!trimmed) {
      if (isNew) {
        await onCancelNew?.()
      } else {
        setEditingTitle(title)
      }
      onEndEdit?.()
      return
    }
    if (trimmed !== title) {
      await onSave(trimmed)
    }
    onEndEdit?.()
  }

  const cancelTitle = async () => {
    if (isNew) {
      await onCancelNew?.()
    } else {
      setEditingTitle(title)
    }
    onEndEdit?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void cancelTitle()
    }
  }

  const handleBlur = (e: React.FocusEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    void saveTitle()
  }

  return {
    inputRef,
    editingTitle,
    setEditingTitle,
    saveTitle,
    cancelTitle,
    handleKeyDown,
    handleBlur,
  }
}
