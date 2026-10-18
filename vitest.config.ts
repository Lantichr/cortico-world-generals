import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { defineConfig } from 'vitest/config';

const temporaryDir = realpathSync.native(tmpdir());

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh', TEMP: temporaryDir, TMP: temporaryDir, TMPDIR: temporaryDir },
    testTimeout: 20_000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
