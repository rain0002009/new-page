import { useEffect, useRef, useState } from 'react'

export interface InlineEditOptions {
  title: string
  isEditing?: boolean
  scrollIntoView?: boolean
  onSave: (trimmed: string) => Promise<void> | void
  onEndEdit?: () => void
}

export function useInlineTitleEdit({
  title,
  isEditing = false,
  scrollIntoView = false,
  onSave,
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
      setEditingTitle(title)
      onEndEdit?.()
      return
    }
    if (trimmed !== title) {
      await onSave(trimmed)
    }
    onEndEdit?.()
  }

  const cancelTitle = () => {
    setEditingTitle(title)
    onEndEdit?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelTitle()
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
