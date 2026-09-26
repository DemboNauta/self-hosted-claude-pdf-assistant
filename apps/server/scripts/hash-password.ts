/**
 * Prints an APP_PASSWORD_HASH line for .env.
 * Usage: pnpm --filter @pdfclaudeassistant/server hash-password 'my password'
 *    or: echo 'my password' | node dist/hash-password.js   (keeps it out of `ps` and history)
 */
import { hash } from '@node-rs/argon2';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const password = process.argv[2] ?? (await readStdin());
if (!password) {
  console.error("Usage: hash-password '<password>'  (or pipe the password on stdin)");
  process.exit(1);
}
// Single quotes keep the `$` characters literal for both Docker Compose and Node's --env-file.
console.log(`APP_PASSWORD_HASH='${await hash(password)}'`);
