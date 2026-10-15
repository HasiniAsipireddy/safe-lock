/*
 * ─────────────────────────────────────────────────────────────────────────────
 * PLACEHOLDER DOCUMENT — A LAWYER MUST REVIEW THIS BEFORE THE SITE GOES LIVE.
 *
 * Written to satisfy Razorpay's activation requirement for a published Privacy
 * Policy. The "what we collect" section describes what the code actually
 * stores today (see apps/api/prisma/schema.prisma) — keep it in step with the
 * schema. Everything about legal bases, retention and user rights still needs
 * professional drafting.
 *
 * Fill in every [BRACKETED] value. Do not publish as-is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Metadata } from 'next';
import { LegalPage, List, Section } from '@/components/ui/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy Policy · Safe Lock',
  description: 'How the Safe Lock platform handles your personal data.',
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="[DATE]">
      <Section heading="1. Who controls your data">
        <p>
          <strong>[BUSINESS NAME]</strong>, <strong>[ADDRESS]</strong>, is the data controller for
          the personal data described here. Contact: <strong>[EMAIL]</strong>,{' '}
          <strong>[PHONE]</strong>.
        </p>
        <p>[TO BE CONFIRMED: whether a Grievance Officer must be named, and by whom.]</p>
      </Section>

      <Section heading="2. What we collect">
        <p>This is what the service actually stores today:</p>
        <List
          items={[
            <>
              <strong>Account details</strong> — your name, email address and mobile number.
            </>,
            <>
              <strong>Your password</strong> — stored only as an argon2 hash. We cannot read it.
            </>,
            <>
              <strong>Payment records</strong> — the Razorpay order and payment identifiers, the
              amount, the currency and the status. We never receive or store your card, UPI or bank
              details; those go directly to Razorpay.
            </>,
            <>
              <strong>Security and activity logs</strong> — the action taken (sign-in, payment,
              lock, unlock), the time, your IP address and your browser’s user-agent string.
            </>,
          ]}
        />
      </Section>

      <Section heading="3. What we do not collect">
        <List
          items={[
            'Card numbers, CVVs, UPI PINs or bank credentials — these never reach our servers.',
            'One-time codes are stored only as a hash, and are never written to logs.',
            'Location data, advertising identifiers, or any third-party analytics or tracking. [CONFIRM BEFORE LAUNCH — if analytics are added later, this section must be updated.]',
          ]}
        />
      </Section>

      <Section heading="4. Why we use it">
        <List
          items={[
            'To create and secure your account, and to sign you in.',
            'To take and verify your activation payment.',
            'To allocate a safe lock to you and carry out the lock and unlock commands you give.',
            'To keep a security record of who opened the safe and when.',
            'To meet legal, tax and accounting obligations.',
          ]}
        />
        <p>
          [TO BE DRAFTED BY A LAWYER: the lawful basis for each purpose under the Digital Personal
          Data Protection Act, 2023, and the consent notice it requires.]
        </p>
      </Section>

      <Section heading="5. Who we share it with">
        <List
          items={[
            <>
              <strong>Razorpay</strong> — our payment gateway, which processes your payment and
              receives your name, email and phone number for that purpose. Razorpay’s own privacy
              policy applies to what it does with that data.
            </>,
            <>
              <strong>[HOSTING / INFRASTRUCTURE PROVIDER]</strong> — hosts the application and
              database.
            </>,
            <>
              <strong>[SMS / MESSAGING PROVIDER]</strong> — delivers one-time codes. [TO BE
              DECIDED — the OTP channel is still an open question.]
            </>,
          ]}
        />
        <p>We do not sell your personal data.</p>
      </Section>

      <Section heading="6. How long we keep it">
        <p>
          [TO BE DECIDED AND THEN REVIEWED BY A LAWYER: retention periods for account data, payment
          records (likely driven by tax law) and security logs, plus what is deleted when an account
          closes.]
        </p>
      </Section>

      <Section heading="7. How we protect it">
        <List
          items={[
            'Traffic is served over HTTPS.',
            'Passwords are hashed with argon2id and are never stored or logged in readable form.',
            'Session tokens are held in httpOnly cookies, so page scripts cannot read them.',
            'Payment confirmations are verified on our server against a signature from Razorpay; the browser is never trusted to say a payment succeeded.',
            'Access to the production database is restricted to [WHO].',
          ]}
        />
        <p>
          No system is perfectly secure. If a breach affects you we will notify you and the relevant
          authority as the law requires.
        </p>
      </Section>

      <Section heading="8. Your rights">
        <p>
          [TO BE DRAFTED BY A LAWYER: the rights available under the Digital Personal Data
          Protection Act, 2023 — access, correction, erasure, grievance redressal and nomination —
          and how a user exercises each one.]
        </p>
        <p>
          To make a request in the meantime, write to <strong>[EMAIL]</strong>.
        </p>
      </Section>

      <Section heading="9. Cookies">
        <p>
          We set cookies that are strictly necessary to keep you signed in. We do not use
          advertising or analytics cookies. [UPDATE THIS IF THAT EVER CHANGES.]
        </p>
      </Section>

      <Section heading="10. Children">
        <p>[TO BE DECIDED: the minimum age for an account, and how it is checked.]</p>
      </Section>

      <Section heading="11. Changes">
        <p>
          If this policy changes we will update the date at the top of the page. [TO BE DECIDED: how
          material changes are communicated.]
        </p>
      </Section>
    </LegalPage>
  );
}
