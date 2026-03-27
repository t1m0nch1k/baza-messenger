import 'express';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        phone: string;
        role: string;
      };
    }
  }
}

export {};

