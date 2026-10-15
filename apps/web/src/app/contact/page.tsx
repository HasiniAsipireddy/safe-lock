/*
 * ─────────────────────────────────────────────────────────────────────────────
 * PLACEHOLDER PAGE — REVIEW BEFORE THE SITE GOES LIVE.
 *
 * Razorpay's activation review expects a reachable contact page with a real
 * business name, address, email and phone number. Every [BRACKETED] value here
 * must be replaced with genuine details — a payment gateway will reject
 * placeholder or unreachable contact information.
 *
 * This is a static page on purpose: no contact form, so there is no endpoint
 * to abuse and no message data to store.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, List, Section } from '@/components/ui/LegalPage';

export const metadata: Metadata = {
  title: 'Contact Us · Safe Lock',
  description: 'How to contact the Safe Lock team.',
};

export default function ContactPage() {
  return (
    <LegalPage title="Contact Us" lastUpdated="[DATE]">
      <Section heading="Business details">
        <p>
          <strong>[BUSINESS NAME]</strong>
          <br />
          [ADDRESS]
          <br />
          [CITY], [STATE] [PIN CODE]
          <br />
          India
        </p>
        <p>[ADD IF APPLICABLE: GSTIN, CIN or registration number.]</p>
      </Section>

      <Section heading="Get in touch">
        <List
          items={[
            <>
              <strong>Email:</strong> [EMAIL]
            </>,
            <>
              <strong>Phone:</strong> [PHONE]
            </>,
            <>
              <strong>Support hours:</strong> [DAYS AND HOURS, WITH TIME ZONE]
            </>,
          ]}
        />
      </Section>

      <Section heading="If you are locked out of your safe">
        <p>
          Contact us on <strong>[PHONE]</strong> straight away rather than by email, and have your
          registered email address or mobile number ready so we can identify your account.
        </p>
        <p>
          [TO BE DECIDED: the out-of-hours escalation path, and whether a physical key override
          exists on the hardware.]
        </p>
      </Section>

      <Section heading="Security reports">
        <p>
          If you believe you have found a security problem with this service, email{' '}
          <strong>[SECURITY EMAIL]</strong> with the details. Please do not test against other
          people’s accounts or safes.
        </p>
      </Section>

      <Section heading="Payments and refunds">
        <p>
          For a question about a payment, quote your Razorpay order id (shown on your payment
          receipt). See also the{' '}
          <Link href="/refund-policy" className="font-semibold underline underline-offset-2">
            Refund Policy
          </Link>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
