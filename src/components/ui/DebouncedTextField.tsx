import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import TextField, { TextFieldProps } from '@mui/material/TextField'
import { useDebounceCallback } from 'usehooks-ts'


export type DebouncedTextFieldControls = {
  cancel: () => void
  flush: () => void
}

type DebouncedTextFieldProps = Omit<TextFieldProps, 'value'> & {
  value: string
  onCommit: (nextValue: string) => void
  debounceMs?: number
  flushOnBlur?: boolean
  flushOnUnmount?: boolean
  cancelPendingOnExternalChange?: boolean
  onValueChange?: (nextValue: string) => void
  debounceControlsRef?: MutableRefObject<DebouncedTextFieldControls | null>
}

function DebouncedTextField({
  value,
  onCommit,
  onChange,
  onBlur,
  debounceMs = 1000,
  flushOnBlur = true,
  flushOnUnmount = true,
  cancelPendingOnExternalChange = true,
  onValueChange,
  debounceControlsRef,
  ...textFieldProps
}: DebouncedTextFieldProps) {
  const [localValue, setLocalValue] = useState(value)
  const lastCommittedValueRef = useRef(value)

  const handleCommit = useCallback(
    (nextValue: string) => {
      lastCommittedValueRef.current = nextValue
      onCommit(nextValue)
    },
    [onCommit],
  )

  const debouncedCommit = useDebounceCallback(
    handleCommit,
    debounceMs,
  )

  const debouncedCommitRef = useRef(debouncedCommit)

  useEffect(
    () => {
      debouncedCommitRef.current = debouncedCommit
    },
    [debouncedCommit],
  )

  const cancelDebouncedCommit = useCallback(
    () => {
      debouncedCommitRef.current.cancel()
    },
    [],
  )

  const flushDebouncedCommit = useCallback(
    () => {
      debouncedCommitRef.current.flush()
    },
    [],
  )

  const queueDebouncedCommit = useCallback(
    (nextValue: string) => {
      debouncedCommitRef.current(nextValue)
    },
    [],
  )

  useEffect(
    () => {
      if (value === lastCommittedValueRef.current) {
        return
      }

      if (cancelPendingOnExternalChange) {
        cancelDebouncedCommit()
      }

      const timeoutId = globalThis.setTimeout(() => {
        setLocalValue(value)
        onValueChange?.(value)
        lastCommittedValueRef.current = value
      }, 0)

      return () => {
        globalThis.clearTimeout(timeoutId)
      }
    },
    [cancelDebouncedCommit, cancelPendingOnExternalChange, onValueChange, value],
  )

  useEffect(
    () => {
      if (!debounceControlsRef) {
        return
      }

      debounceControlsRef.current = {
        cancel: cancelDebouncedCommit,
        flush: flushDebouncedCommit,
      }

      return () => {
        debounceControlsRef.current = null
      }
    },
    [cancelDebouncedCommit, debounceControlsRef, flushDebouncedCommit],
  )

  useEffect(
    () => () => {
      if (flushOnUnmount) {
        flushDebouncedCommit()
      }
    },
    [flushDebouncedCommit, flushOnUnmount],
  )

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nextValue = event.target.value
      setLocalValue(nextValue)
      onValueChange?.(nextValue)
      queueDebouncedCommit(nextValue)
      onChange?.(event)
    },
    [onChange, onValueChange, queueDebouncedCommit],
  )

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (flushOnBlur) {
        cancelDebouncedCommit()
        onCommit(localValue)
      }

      onBlur?.(event)
    },
    [cancelDebouncedCommit, flushOnBlur, localValue, onBlur, onCommit],
  )

  return (
    <TextField
      {...textFieldProps}
      onBlur={handleBlur}
      onChange={handleChange}
      value={localValue}
    />
  )
}

export default DebouncedTextField
