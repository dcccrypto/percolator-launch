import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/**
 * MSW Server for Node.js (Vitest)
 * 
 * Intercepts HTTP requests during tests and returns mock responses
 * according to the handlers defined in handlers.ts
 */
export const server = setupServer(...handlers);
