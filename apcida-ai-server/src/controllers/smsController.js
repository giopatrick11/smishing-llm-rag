const { smsRequestSchema } = require('../validators/sms');

function createSmsController(ollama, model) {
  return async function analyzeSms(req, res, next) {
    const parsed = smsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] || 'body'))];
      return res.status(400).json({ error: 'INVALID_REQUEST', fields });
    }

    try {
      const started = performance.now();
      const analysis = await ollama.analyze(parsed.data);
      res.json({
        messageId: parsed.data.messageId,
        ...analysis,
        model,
        processingTimeMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createSmsController };
