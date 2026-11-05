import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    // Generous: beforeAll spins up a real sshd (host-key generation) and the Go
    // MCP bridge handshake, which can be slow on a cold CI runner.
    hookTimeout: 150_000,
    fileParallelism: false,
  },
});
