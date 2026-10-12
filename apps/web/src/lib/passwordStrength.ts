import { PASSWORD_RULES } from '@safelock/shared';

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  /** 0 = empty, 1 = weak … 4 = strong. */
  score: StrengthLevel;
  label: string;
  /** The next thing the user could do to improve the password. */
  hint: string;
}

/**
 * Lightweight, dependency-free strength heuristic for the signup meter.
 * It is UI guidance only — the enforced policy lives in `passwordSchema`.
 */
export function getPasswordStrength(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: 'Enter a password', hint: '' };
  }

  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const longEnough = password.length >= PASSWORD_RULES.minLength;

  let points = 0;
  if (longEnough) points += 1;
  if (password.length >= 12) points += 1;
  if (hasLower && hasUpper) points += 1;
  if (hasDigit) points += 1;
  if (hasSymbol) points += 1;

  // Obvious patterns cap the score no matter how long the password is.
  const repeated = /(.)\1{2,}/.test(password);
  const sequential = /(?:abc|bcd|cde|123|234|345|456|567|678|789|890|qwe|asd)/i.test(password);
  const common = /^(?:password|welcome|admin|letmein|safelock|iloveyou)/i.test(password);
  if (repeated || sequential || common) points = Math.min(points, 2);

  const score = (longEnough ? Math.min(Math.max(points, 1), 4) : 1) as StrengthLevel;

  let hint = '';
  if (!longEnough) hint = `Use at least ${PASSWORD_RULES.minLength} characters`;
  else if (!hasDigit) hint = 'Add a number';
  else if (!hasLower || !hasUpper) hint = 'Mix upper and lower case';
  else if (common || sequential || repeated) hint = 'Avoid common words and repeated characters';
  else if (!hasSymbol) hint = 'Add a symbol for extra strength';
  else if (password.length < 12) hint = 'Longer passwords are stronger';

  const labels = ['Enter a password', 'Weak', 'Fair', 'Good', 'Strong'] as const;

  return { score, label: labels[score], hint };
}
