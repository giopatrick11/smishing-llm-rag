Open Terminal and go to the server folder

cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm ci

Start the supporting programs
ollama list

Then start the local database
brew services start postgresql@17
pg_isready -h 127.0.0.1 -p 5432

In another terminal
cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
npm start

In another terminal
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/ai/status

soo debale

npm start

then new terminal then copy the url
cloudflared tunnel --url <insert> ... example: cloudflared tunnel --url http://127.0.0.1:3000

then i replace ang url

cd /Users/giopatrick/smishing-llm-rag/apcida-ai-server
APCIDA_TUNNEL_URL='https://YOUR-LINK.trycloudflare.com' node <<'NODE'
require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');

fetch(`${process.env.APCIDA_TUNNEL_URL}/api/sms/analyze`, {
method: 'POST',
headers: {
'content-type': 'application/json',
'x-api-key': process.env.API_KEY
},
body: JSON.stringify({
messageId: randomUUID(),
sender: 'ManualTest',
text: 'Reminder: your appointment is tomorrow at 9 AM.',
receivedAt: new Date().toISOString()
})
})
.then(async response => {
console.log('HTTP', response.status);
console.log(await response.text());
})
.catch(error => console.error(error.message));
NODE
