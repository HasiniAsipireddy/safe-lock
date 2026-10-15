/*
 * ─────────────────────────────────────────────────────────────────────────────
 * PLACEHOLDER DOCUMENT — A LAWYER MUST REVIEW THIS BEFORE THE SITE GOES LIVE.
 *
 * This page is a PLACEHOLDER ON PURPOSE. "Refund / device return policy?" is
 * still an open question in CLAUDE.md, and inventing a refund promise would
 * create a commitment nobody has agreed to.
 *
 * The decisions that have to be made first are listed on the page itself and
 * in the TODO block below. Once they are settled, record them in
 * docs/decisions.md and rewrite this page.
 *
 * TODO(refund-policy) — decisions required before launch:
 *   1. Is the activation payment refundable at all? If so, within how many days?
 *   2. Does the window start at payment, at dispatch, or at delivery of the
 *      physical safe?
 *   3. Must the device be returned to qualify? Who pays return shipping?
 *   4. What condition must a returned device be in? Any restocking fee?
 *   5. Are partial refunds ever given (e.g. device used, then returned)?
 *   6. What happens to the device allocation on refund — revoked immediately,
 *      or at the end of a notice period? (The API currently revokes access as
 *      soon as a refund.processed webhook arrives.)
 *   7. How are refunds issued — Razorpay refund to the original method only?
 *   8. How long does a refund take to reach the customer?
 *   9. What is the cancellation position before a device is allocated?
 *  10. Faulty-device / warranty replacement path — is that a refund or an RMA?
 *  11. Required by Indian consumer law: a named grievance contact and a
 *      response timeline.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, List, Section } from '@/components/ui/LegalPage';

export const metadata: Metadata = {
  title: 'Refund Policy · Safe Lock',
  description: 'Refund and cancellation policy for the Safe Lock smart safe platform.',
};

const OPEN_DECISIONS = [
  'Is the one-time activation payment refundable at all, and within how many days?',
  'Does the refund window start at payment, at dispatch, or at delivery?',
  'Must the safe lock be returned to qualify, and who pays return shipping?',
  'What condition must a returned device be in? Is there a restocking fee?',
  'Are partial refunds ever given?',
  'On refund, is the device allocation revoked immediately or after a notice period?',
  'Are refunds issued only to the original payment method, via Razorpay?',
  'How long does a refund take to reach the customer?',
  'What is the cancellation position before a device has been allocated?',
  'Is a faulty device a refund or a warranty replacement?',
  'Who is the named grievance contact, and what is the response timeline?',
];

export default function RefundPolicyPage() {
  return (
    <LegalPage title="Refund &amp; Cancellation Policy" lastUpdated="[DATE]">
      <aside
        role="note"
        className="rounded-xl border-2 border-dashed border-red-400 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
      >
        <p className="font-bold">This policy has not been decided yet</p>
        <p className="mt-1">
          Nothing on this page is a commitment. The refund terms for Safe Lock are still being
          worked out, and no refund promise should be relied on until this page is replaced with a
          final, lawyer-reviewed version.
        </p>
      </aside>

      <Section heading="Current position">
        <p>
          <strong>[BUSINESS NAME]</strong> has not yet published final refund terms for the
          one-time safe activation payment. If you have paid and want a refund, contact us directly
          and we will deal with your request individually:
        </p>
        <p>
          <strong>[EMAIL]</strong> · <strong>[PHONE]</strong>
          <br />
          <strong>[BUSINESS NAME], [ADDRESS]</strong>
        </p>
      </Section>

      <Section heading="What we can confirm today">
        <List
          items={[
            'Payments are taken once, as a one-time activation charge — there is no recurring subscription and nothing to cancel on a schedule.',
            'Payments are processed by Razorpay, and any refund we issue is returned through Razorpay.',
            'If a refund is processed, your account stops counting as activated and the safe lock allocation is withdrawn.',
            'Nothing here limits any right you have under the Indian Consumer Protection Act, 2019.',
          ]}
        />
      </Section>

      <Section heading="Decisions still to be made">
        <p>
          These are the points that must be settled, written up and reviewed by a lawyer before
          this page is final:
        </p>
        <List items={OPEN_DECISIONS} />
      </Section>

      <Section heading="Raising a concern">
        <p>
          Write to <strong>[EMAIL]</strong>, or see the{' '}
          <Link href="/contact" className="font-semibold underline underline-offset-2">
            contact page
          </Link>
          . [TO BE DECIDED: the response time we commit to.]
        </p>
      </Section>
    </LegalPage>
  );
}
