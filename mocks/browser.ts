import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/**
 * MSW Worker for Browser (E2E tests)
 * 
 * Intercepts HTTP requests in the browser during E2E tests
 * according to the handlers defined in handlers.ts
 * 
 * Usage in E2E tests:
 * ```ts
 * import { worker } from '../mocks/browser';
 * 
 * beforeAll(() => worker.start());
 * afterAll(() => worker.stop());
 * ```
 */
export const worker = setupWorker(...handlers);
