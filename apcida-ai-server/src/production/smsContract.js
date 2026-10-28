const { z } = require('zod');

// Contract preparation only. No route imports or mounts this module.
const productionSmsRequestSchema = z.strictObject({
  messageId: z.uuid(),
  sender: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(2000),
  receivedAt: z.iso.datetime({ offset: true }),
});

const productionSmsResponseSchema = z.strictObject({
  messageId: z.uuid(),
  classification: z.enum(['SCAM', 'SAFE', 'SUSPICIOUS']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  rationale: z.string().trim().min(1).max(300),
});

function validateProductionRequest(body, idempotencyKey) {
  const result = productionSmsRequestSchema.safeParse(body);
  if (!result.success || idempotencyKey !== result.data.messageId) return null;
  return result.data;
}

function validateProductionResponse(body, requestId) {
  const result = productionSmsResponseSchema.safeParse(body);
  if (!result.success || result.data.messageId !== requestId) return null;
  return result.data;
}

module.exports = { productionSmsRequestSchema, productionSmsResponseSchema,
  validateProductionRequest, validateProductionResponse };
