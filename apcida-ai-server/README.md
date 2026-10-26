# ApCiDa AI server

Local Express API for analyzing one SMS at a time with `gemma3:12b` through Ollama. The server listens on `127.0.0.1` only. It keeps no SMS database and does not log request bodies or SMS text. Opening `/` in a browser shows the available API routes.

## Requirements

- Node.js 20 or newer
- Ollama running locally with `gemma3:12b` installed

## Install and configure

Run these commands in Terminal:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm ci
printf 'API_KEY=%s\n' "$(openssl rand -hex 32)" > .env
```

The generated `.env` is ignored by Git. Optional settings can be added to it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local Express port |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama origin; only loopback HTTP is accepted |
| `OLLAMA_MODEL` | `gemma3:12b` | Exact Ollama model name |
| `API_KEY` | required | Secret of at least 16 characters for SMS analysis |
| `REQUEST_TIMEOUT_MS` | `120000` | Ollama request timeout, 1,000 to 300,000 ms |

The example values are in `.env.example`. Express always binds to `127.0.0.1`; no host environment setting can expose it on a network interface. Keep Ollama bound to localhost as well.

## Start

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm start
```

In a second Terminal window, check both health and model availability:

```sh
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/api/ai/status
```

`/health` reports whether Express is running. `/api/ai/status` checks Ollama's `/api/tags` endpoint for the exact configured model name. It returns HTTP 503 when Ollama or the model is unavailable.

Analyze an SMS from the second Terminal window:

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
source .env
curl -sS -X POST http://127.0.0.1:3000/api/sms/analyze \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  --data '{"messageId":"example-001","sender":"ExampleSender","text":"Your appointment is tomorrow at 9 AM.","receivedAt":"2026-10-26T09:00:00+08:00"}'
```

A successful response has this shape:

```json
{
  "messageId": "example-001",
  "classification": "SAFE",
  "confidence": "MEDIUM",
  "rationale": "This appears to be an ordinary appointment reminder.",
  "model": "gemma3:12b",
  "processingTimeMs": 1234
}
```

The values above illustrate the response format; the model decides the classification and rationale. The request must contain exactly `messageId`, `sender`, `text`, and an ISO 8601 `receivedAt` with a time zone. Text is limited to 2,000 characters, the full JSON body to 8 KB, and analysis requests to 30 per minute per local client address. `POST /api/sms/analyze` requires the `x-api-key` header. The other two endpoints do not.

The model receives a fixed instruction to weigh concrete evidence in English, Filipino, or Cebuano. An OTP, urgent wording, or unfamiliar URL alone is not treated as proof of a scam. The model's JSON response is checked against a strict Zod schema before it is returned. A classification is an assessment of the SMS text, not independent verification of the sender or any URL.

Error responses use codes such as `UNAUTHORIZED` (401), `INVALID_REQUEST` (400), `REQUEST_TOO_LARGE` (413), `RATE_LIMITED` (429), `OLLAMA_UNAVAILABLE` (503), `OLLAMA_OVERLOADED` (503), `OLLAMA_TIMEOUT` (504), and `OLLAMA_INVALID_RESPONSE` (502). They do not include raw SMS content or upstream error bodies.

## Test

```sh
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm test
```

The automated tests mock Ollama and open a temporary local HTTP port. Ollama does not need to be running for them. The API currently handles one message per request and has no RAG, database, contribution, report, batch, or phone connectivity features. The service, controller, and route boundaries leave room to add those features later.
