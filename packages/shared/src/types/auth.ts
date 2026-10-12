import type { ErrorCode } from '../constants';

export type UserRole = 'USER' | 'ADMIN';

/** The only user shape the API ever sends to a client. Never includes a hash. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  createdAt: string;
}

/** Response body of `POST /auth/login`, `POST /auth/signup` and `GET /auth/me`. */
export interface AuthResponse {
  user: PublicUser;
}

/** The consistent error envelope used by every endpoint. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    /** Optional per-field messages for VALIDATION_ERROR. */
    fields?: Record<string, string>;
  };
}
