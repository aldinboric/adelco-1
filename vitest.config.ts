import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The shared module and the server are pure Node code: no DOM needed.
  test: {
    environment: 'node',
  },
});
