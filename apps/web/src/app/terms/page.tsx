/*
 * ─────────────────────────────────────────────────────────────────────────────
 * PLACEHOLDER DOCUMENT — A LAWYER MUST REVIEW THIS BEFORE THE SITE GOES LIVE.
 *
 * Written to satisfy Razorpay's activation requirement for a published Terms
 * of Service page. It deliberately makes no legal claims, no warranties, and
 * no liability statements that have not been decided by the business.
 *
 * Fill in every [BRACKETED] value. Do not publish as-is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Metadata } from 'next';
import { LegalPage, List, Section } from '@/components/ui/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of Service · Safe Lock',
  description: 'Terms of Service for the Safe Lock smart safe platform.',
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="[DATE]">
      <Section heading="1. Who we are">
        <p>
          This service is operated by <strong>[BUSINESS NAME]</strong>, registered at{' '}
          <strong>[ADDRESS]</strong>. You can reach us at <strong>[EMAIL]</strong> or{' '}
          <strong>[PHONE]</strong>.
        </p>
      </Section>

      <Section heading="2. What the service does">
        <p>
          Safe Lock is a web platform for locking and unlocking a physical smart safe remotely.
          After you create an account and complete the one-time activation payment, a safe lock
          device is allocated to your account.
        </p>
      </Section>

      <Section heading="3. Your account">
        <List
          items={[
            'You must provide accurate registration details and keep them up to date.',
            'You are responsible for keeping your password confidential.',
            'You must not share your account with anyone you would not trust with physical access to the safe.',
            'Tell us immediately at [EMAIL] if you believe someone else has access to your account.',
          ]}
        />
      </Section>

      <Section heading="4. Payment">
        <List
          items={[
            'Activation is a one-time payment. The current price is shown on the payment page before you pay.',
            'Payments are processed by Razorpay. We do not receive or store your card details.',
            'Prices are in Indian Rupees (INR) and include [TAXES — STATE WHETHER GST IS INCLUDED].',
            'Refunds are governed by our Refund Policy.',
          ]}
        />
      </Section>

      <Section heading="5. Using the safe lock">
        <List
          items={[
            'Unlocking the safe always requires a one-time code sent to you. Do not share that code.',
            'The service depends on your internet connection, your safe’s connectivity, and third-party networks. It may be unavailable at times.',
            '[TO BE DECIDED: whether a physical key override is provided, and what the user is responsible for if the device is offline.]',
          ]}
        />
      </Section>

      <Section heading="6. Acceptable use">
        <List
          items={[
            'Do not use the service for any unlawful purpose.',
            'Do not attempt to access any safe or account that is not yours.',
            'Do not probe, scan, or interfere with the security of the service. [BUSINESS NAME] may suspend accounts that do.',
          ]}
        />
      </Section>

      <Section heading="7. Suspension and termination">
        <p>
          [TO BE DRAFTED BY A LAWYER: the grounds on which an account may be suspended or
          terminated, the notice given, and what happens to the allocated device.]
        </p>
      </Section>

      <Section heading="8. Liability">
        <p>
          [TO BE DRAFTED BY A LAWYER. This is a physical-security product; the limitation of
          liability, warranty position and consumer-law carve-outs must be written and reviewed
          professionally, and must comply with the Indian Consumer Protection Act, 2019. No wording
          has been invented here.]
        </p>
      </Section>

      <Section heading="9. Changes to these terms">
        <p>
          We may update these terms. [TO BE DECIDED: how much notice is given and how users are
          informed.] The date at the top of this page shows when it was last changed.
        </p>
      </Section>

      <Section heading="10. Governing law and disputes">
        <p>
          [TO BE DRAFTED BY A LAWYER: governing law and the courts or arbitration forum with
          jurisdiction. Commonly the courts of [CITY], India, but this must be confirmed.]
        </p>
      </Section>

      <Section heading="11. Contact">
        <p>
          Questions about these terms: <strong>[EMAIL]</strong>, or write to{' '}
          <strong>[BUSINESS NAME], [ADDRESS]</strong>.
        </p>
      </Section>
    </LegalPage>
  );
}
