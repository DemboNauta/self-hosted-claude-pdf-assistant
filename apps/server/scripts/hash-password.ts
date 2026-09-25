/**
 * Prints an APP_PASSWORD_HASH line for .env.
 * Usage: pnpm --filter @pdfclaudeassistant/server hash-password 'my password'
 */
import { hash } from '@node-rs/argon2';

const password = process.argv[2];
if (!password) {
  console.error("Usage: hash-password '<password>'");
  process.exit(1);
}
// Single quotes keep the `$` characters literal for both Docker Compose and Node's --env-file.
console.log(`APP_PASSWORD_HASH='${await hash(password)}'`);
