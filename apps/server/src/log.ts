export const LOG_PREFIX = '[PdfClaudeAssistant]';

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  msgPrefix: `${LOG_PREFIX} `,
  redact: ['req.headers.cookie', 'req.headers.authorization'],
};
