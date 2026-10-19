import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
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
  blurOnEnter?: boolean
}

function DebouncedTextField({
  value,
  onCommit,
  onChange,
  onBlur,
  onKeyDown,
  debounceMs = 1000,
  flushOnBlur = true,
  flushOnUnmount = true,
  cancelPendingOnExternalChange = true,
  onValueChange,
  debounceControlsRef,
  blurOnEnter,
  slotProps,
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

  const shouldBlurOnEnter = blurOnEnter ?? !textFieldProps.multiline

  const htmlInputProp = slotProps?.htmlInput
  const callerEnterKeyHint =
    typeof htmlInputProp === 'object' && htmlInputProp !== null && 'enterKeyHint' in htmlInputProp
      ? (htmlInputProp as React.InputHTMLAttributes<HTMLInputElement>).enterKeyHint
      : undefined

  const resolvedEnterKeyHint = callerEnterKeyHint ?? (shouldBlurOnEnter ? 'done' : undefined)

  const mergedSlotProps = useMemo(() => {
    if (!resolvedEnterKeyHint) {
      return slotProps
    }

    if (typeof slotProps?.htmlInput === 'function') {
      const originalFn = slotProps.htmlInput
      return {
        ...slotProps,
        htmlInput: (ownerState: Parameters<typeof originalFn>[0]) => ({
          ...originalFn(ownerState),
          enterKeyHint: resolvedEnterKeyHint,
        }),
      }
    }

    return {
      ...slotProps,
      htmlInput: {
        ...slotProps?.htmlInput,
        enterKeyHint: resolvedEnterKeyHint,
      },
    }
  }, [resolvedEnterKeyHint, slotProps])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) {
        return
      }

      if (
        shouldBlurOnEnter &&
        event.key === 'Enter' &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault()
        if (flushOnBlur && localValue !== lastCommittedValueRef.current) {
          cancelDebouncedCommit()
          handleCommit(localValue)
        }
        if (event.target instanceof HTMLElement) {
          event.target.blur()
        }
      }
    },
    [
      cancelDebouncedCommit,
      flushOnBlur,
      handleCommit,
      localValue,
      onKeyDown,
      shouldBlurOnEnter,
    ],
  )

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (flushOnBlur) {
        cancelDebouncedCommit()
        if (localValue !== lastCommittedValueRef.current) {
          handleCommit(localValue)
        }
      }

      onBlur?.(event)
    },
    [cancelDebouncedCommit, flushOnBlur, handleCommit, localValue, onBlur],
  )

  return (
    <TextField
      {...textFieldProps}
      onBlur={handleBlur}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      slotProps={mergedSlotProps}
      value={localValue}
    />
  )
}

export default DebouncedTextField
