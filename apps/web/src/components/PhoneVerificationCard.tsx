'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ERROR_CODES,
  PHONE_OTP_RESEND_COOLDOWN_SECONDS,
  WHATSAPP_CONSENT_TEXT,
  phoneE164Schema,
  type AuthResponse,
  type PhoneVerificationRequestResponse,
} from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/apiError';
import { USE_MOCK_API } from '@/lib/env';
import { peekMockPhoneCode } from '@/lib/mockApi';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { OtpInput } from '@/components/OtpInput';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { cn } from '@/lib/cn';

/**
 * Phone verification, in two steps on one card.
 *
 * The number is where unlock codes go, so this is the control that decides
 * whether the safe can be opened at all. Two things it is careful about:
 *
 * - **The masked number is shown in step two.** The API answers identically
 *   whether the number is free or belongs to someone else (it must, or it
 *   would be an oracle for who owns a safe), so this is the only way a user
 *   who mistyped a digit can notice before waiting for a code that is never
 *   coming.
 * - **Consent is a real checkbox, required before the first send.** Meta
 *   requires an explicit opt-in, and the wording comes from
 *   `WHATSAPP_CONSENT_TEXT` so the text the user agrees to is the text whose
 *   version the server stores.
 */

type Step = 'enter-number' | 'enter-code';

export function PhoneVerificationCard() {
  const { user, refreshUser } = useAuth();
  const [step, setStep] = useState<Step>('enter-number');
  const [challenge, setChallenge] = useState<PhoneVerificationRequestResponse | null>(null);

  const alreadyVerified = user?.phoneVerified ?? false;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">
          {alreadyVerified ? 'Phone number' : 'Verify your phone number'}
        </h2>
        <VerifiedBadge verified={alreadyVerified} />
      </div>

      {step === 'enter-number' ? (
        <NumberStep
          alreadyVerified={alreadyVerified}
          currentPhone={user?.phone ?? ''}
          onSent={(result) => {
            setChallenge(result);
            setStep('enter-code');
          }}
        />
      ) : (
        <CodeStep
          challenge={challenge!}
          onVerified={async () => {
            await refreshUser();
            setStep('enter-number');
            setChallenge(null);
          }}
          onBack={() => {
            setStep('enter-number');
            setChallenge(null);
          }}
        />
      )}
    </section>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold',
        verified
          ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'
          : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
      )}
    >
      {/* Icon plus text, never colour alone. */}
      <span aria-hidden="true">{verified ? '✓' : '!'}</span>
      {verified ? 'Verified' : 'Not verified'}
    </span>
  );
}

function NumberStep({
  alreadyVerified,
  currentPhone,
  onSent,
}: {
  alreadyVerified: boolean;
  currentPhone: string;
  onSent: (result: PhoneVerificationRequestResponse) => void;
}) {
  const consentId = useId();
  const [phone, setPhone] = useState(alreadyVerified ? '' : currentPhone);
  const [consent, setConsent] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    const parsed = phoneE164Schema.safeParse(phone);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Enter a valid mobile number');
      return;
    }
    if (!consent) {
      setError('Please agree to receive WhatsApp messages so we can send your code.');
      return;
    }

    setSending(true);
    try {
      const result = await api.post<PhoneVerificationRequestResponse>(
        '/account/phone/request-verification',
        {
          phone: parsed.data,
          consent: true,
          ...(alreadyVerified ? { currentPassword } : {}),
        },
      );
      onSent(result);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
      <FormError variant="banner" message={error ?? undefined} />

      {alreadyVerified ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Your verified number is <strong>+91 {currentPhone}</strong>. It will keep receiving
          unlock codes until a new number is confirmed.
        </p>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Unlock codes are sent to your phone on WhatsApp, so we need to confirm the number
          before you can unlock your safe.
        </p>
      )}

      <Input
        label={alreadyVerified ? 'New phone number' : 'Phone number'}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        prefix="+91"
        placeholder="9876543210"
        hint="10-digit Indian mobile number with WhatsApp"
        value={phone}
        error={fieldError ?? undefined}
        onChange={(event) => setPhone(event.target.value)}
      />

      {/* Changing a verified number is a credential change: the number
          receives unlock codes, so the password is required. */}
      {alreadyVerified ? (
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      ) : null}

      <div className="flex items-start gap-3">
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 size-6 shrink-0 rounded-md border-2 border-slate-300 accent-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:border-slate-600"
        />
        <label htmlFor={consentId} className="text-sm text-slate-700 dark:text-slate-300">
          {WHATSAPP_CONSENT_TEXT}
        </label>
      </div>

      <Button type="submit" loading={sending} loadingText="Sending code…">
        Send verification code
      </Button>
    </form>
  );
}

function CodeStep({
  challenge,
  onVerified,
  onBack,
}: {
  challenge: PhoneVerificationRequestResponse;
  onVerified: () => Promise<void>;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [cooldown, setCooldown] = useState(PHONE_OTP_RESEND_COOLDOWN_SECONDS);
  const submittedRef = useRef(false);

  /** Dev-only; never populated by the real API, which returns no code. */
  const [devCode] = useState(() => (USE_MOCK_API ? peekMockPhoneCode() : null));

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function confirm(value: string) {
    // onComplete can fire alongside a manual submit; one request only.
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      await api.post<AuthResponse>('/account/phone/confirm', { otp: value });
      setDone(true);
      await onVerified();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        // A dead challenge cannot be retried — send them back to step one.
        if (
          cause.code === ERROR_CODES.PHONE_VERIFICATION_TOO_MANY_ATTEMPTS ||
          cause.code === ERROR_CODES.PHONE_VERIFICATION_EXPIRED ||
          cause.code === ERROR_CODES.PHONE_VERIFICATION_NOT_FOUND
        ) {
          setCode('');
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
      setCode('');
    } finally {
      submittedRef.current = false;
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p
        role="status"
        className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
      >
        Your phone number is verified. You can now unlock your safe.
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        We sent a 6-digit code on WhatsApp to{' '}
        {/* The masked number: the one way to spot a mistyped digit, since the
            API deliberately answers the same for a number you do not own. */}
        <strong className="whitespace-nowrap">{challenge.maskedPhone}</strong>.
      </p>

      <FormError variant="banner" message={error ?? undefined} />

      <OtpInput
        value={code}
        onChange={setCode}
        onComplete={(value) => void confirm(value)}
        disabled={submitting}
        invalid={Boolean(error)}
        autoFocus
      />

      {devCode ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <span className="font-bold">Mock mode:</span> your code is{' '}
          <span className="font-mono">{devCode}</span>
        </p>
      ) : null}

      <Button
        loading={submitting}
        loadingText="Verifying…"
        disabled={code.length < 6}
        onClick={() => void confirm(code)}
      >
        Verify number
      </Button>

      <div className="flex items-center justify-between gap-3 text-sm">
        <button
          type="button"
          onClick={onBack}
          className="min-h-11 font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-300"
        >
          Use a different number
        </button>
        <span className="text-slate-500 dark:text-slate-400">
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'You can request a new code'}
        </span>
      </div>
    </div>
  );
}

/**
 * The persistent nudge shown to any unverified user, on the dashboard and on
 * `/account`.
 *
 * Deliberately **not** only shown when an unlock is refused. A user who
 * discovers the requirement at the moment they need to open their safe
 * discovers it too late — and the same gap is what makes password reset
 * unreachable for them, since reset is delivered to a verified number.
 */
export function VerifyPhonePrompt({ className }: { className?: string }) {
  const { user } = useAuth();

  if (!user || user.phoneVerified) return null;

  return (
    <section
      role="status"
      className={cn(
        'rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40',
        className,
      )}
    >
      <h2 className="flex items-center gap-2 text-base font-bold text-amber-900 dark:text-amber-100">
        <span aria-hidden="true">!</span>
        Verify your phone number
      </h2>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">
        Unlock codes and password resets are sent on WhatsApp, so your safe cannot be
        unlocked until the number is confirmed. Locking still works.
      </p>
      <a
        href="/account#phone"
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-600 px-5 text-base font-semibold text-white transition-colors hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
      >
        Verify now
      </a>
    </section>
  );
}
