const { OllamaError } = require('../services/ollama');

function createAiController(ollama) {
  return async function getStatus(req, res, next) {
    try {
      const result = await ollama.status();
      res.status(result.modelAvailable ? 200 : 503).json(result);
    } catch (error) {
      if (error instanceof OllamaError) {
        return res.status(error.status).json({
          ollamaAvailable: false,
          modelAvailable: false,
          error: error.code,
        });
      }
      next(error);
    }
  };
}

module.exports = { createAiController };
