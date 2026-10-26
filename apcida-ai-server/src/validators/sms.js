const { z } = require('zod');

const smsRequestSchema = z.strictObject({
  messageId: z.string().trim().min(1).max(128),
  sender: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(2000),
  receivedAt: z.iso.datetime({ offset: true }),
});

const analysisSchema = z.strictObject({
  classification: z.enum(['SCAM', 'SAFE', 'SUSPICIOUS']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  rationale: z.string().trim().min(1).max(300),
});

const analysisJsonSchema = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: ['SCAM', 'SAFE', 'SUSPICIOUS'] },
    confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    rationale: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['classification', 'confidence', 'rationale'],
  additionalProperties: false,
};

module.exports = { smsRequestSchema, analysisSchema, analysisJsonSchema };
