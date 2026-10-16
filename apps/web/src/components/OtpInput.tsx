'use client';

import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { OTP_LENGTH } from '@safelock/shared';
import { cn } from '@/lib/cn';

/**
 * Six single-character boxes that behave like one field.
 *
 * Accessibility notes, because a box-per-digit is easy to get wrong:
 * - Every box is a real `<input>` with its own label, so a screen reader
 *   announces "Digit 3 of 6" rather than six unlabelled text fields.
 * - Backspace on an empty box moves back and clears the previous one, which
 *   is what people expect and what a naive implementation gets wrong.
 * - Arrow keys move between boxes.
 * - Paste is handled on every box, not just the first, and strips spaces and
 *   dashes — codes get copied out of messages with formatting attached.
 * - `inputMode="numeric"` + `pattern` brings up the numeric keypad on mobile
 *   without blocking a hardware keyboard.
 * - `autoComplete="one-time-code"` lets iOS and Android offer the code from
 *   the notification. Only the first box carries it, as the platforms expect.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = false,
}: {
  /** The current code, 0 to {@link OTP_LENGTH} digits. */
  value: string;
  onChange: (next: string) => void;
  /** Called once the last digit lands, so the form can submit itself. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const digits = Array.from({ length: OTP_LENGTH }, (_, index) => value[index] ?? '');

  function focusBox(index: number): void {
    const clamped = Math.max(0, Math.min(OTP_LENGTH - 1, index));
    refs.current[clamped]?.focus();
    refs.current[clamped]?.select();
  }

  function commit(next: string): void {
    const cleaned = next.replace(/\D/g, '').slice(0, OTP_LENGTH);
    onChange(cleaned);
    if (cleaned.length === OTP_LENGTH) onComplete?.(cleaned);
  }

  function handleInput(index: number, raw: string): void {
    const typed = raw.replace(/\D/g, '');
    if (!typed) return;

    // Typing into a box replaces that digit; a multi-character value (an
    // autofilled code, or fast typing) fills forward from here.
    const next = (value.slice(0, index) + typed + value.slice(index + typed.length)).slice(
      0,
      OTP_LENGTH,
    );

    commit(next);
    focusBox(index + typed.length);
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Backspace') {
      event.preventDefault();

      if (digits[index]) {
        commit(value.slice(0, index) + value.slice(index + 1));
        return;
      }
      // Empty box: step back and clear the one behind it.
      if (index > 0) {
        commit(value.slice(0, index - 1) + value.slice(index));
        focusBox(index - 1);
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const pasted = event.clipboardData.getData('text');
    if (!pasted) return;

    event.preventDefault();
    const cleaned = pasted.replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!cleaned) return;

    commit(cleaned);
    focusBox(cleaned.length);
  }

  return (
    <div className="flex justify-between gap-2">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          // `text` rather than `number`: a number input allows `e`, `+` and
          // scroll-to-change, and renders spinners nobody wants here.
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={OTP_LENGTH}
          value={digit}
          disabled={disabled}
          aria-label={`Digit ${index + 1} of ${OTP_LENGTH}`}
          aria-invalid={invalid || undefined}
          onChange={(event) => handleInput(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={handlePaste}
          onFocus={(event) => event.target.select()}
          className={cn(
            'h-14 w-full min-w-0 rounded-xl border text-center font-mono text-2xl font-bold tabular-nums',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            'disabled:cursor-not-allowed disabled:opacity-60',
            invalid
              ? 'border-red-400 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950/50 dark:text-red-100'
              : 'border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white',
          )}
        />
      ))}
    </div>
  );
}
