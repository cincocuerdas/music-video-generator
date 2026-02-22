import { Request } from 'express';

export interface AuthenticatedUser {
  userId: string;
  token: string;
  claims: Record<string, unknown>;
}

export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};
