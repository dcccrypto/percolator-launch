import { beforeAll, afterAll, afterEach } from 'vitest';
import { server } from '../../../mocks/server';

// Establish API mocking before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

// Reset handlers after each test
afterEach(() => {
  server.resetHandlers();
});

// Clean up after all tests
afterAll(() => {
  server.close();
});

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
