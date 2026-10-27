(() => {
  const key = document.getElementById('key');
  const sms = document.getElementById('sms');
  const synthetic = document.getElementById('synthetic');
  const analyze = document.getElementById('analyze');
  const clear = document.getElementById('clear');
  const status = document.getElementById('status');
  const result = document.getElementById('result');

  function clearInputs() {
    key.value = '';
    sms.value = '';
    synthetic.checked = false;
    result.replaceChildren();
    status.textContent = 'No analysis yet.';
  }

  function addResult(label, value) {
    const row = document.createElement('p');
    row.textContent = `${label}: ${value}`;
    result.appendChild(row);
  }

  function errorMessage(httpStatus) {
    if (httpStatus === 401) return 'Invalid API key.';
    if (httpStatus === 400 || httpStatus === 413) return 'The server rejected the test message.';
    if (httpStatus === 429) return 'Rate limit reached. Wait and try again.';
    if (httpStatus === 504) return 'Ollama request timed out.';
    if (httpStatus === 502 || httpStatus === 503) return 'Ollama or the RAG service is unavailable.';
    return `Server returned HTTP ${httpStatus}.`;
  }

  async function run() {
    result.replaceChildren();
    if (!synthetic.checked) {
      status.textContent = 'Confirm that the SMS is synthetic before sending it.';
      return;
    }
    const text = sms.value.trim();
    if (!text || text.length > 2000) {
      status.textContent = 'Enter a synthetic SMS of 1 to 2,000 characters.';
      return;
    }
    if (!key.value) {
      status.textContent = 'Enter the development API key.';
      return;
    }
    const messageId = `manual-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const body = JSON.stringify({ messageId, sender: 'ManualTest', text,
      receivedAt: new Date().toISOString() });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 270000);
    analyze.disabled = true;
    status.textContent = 'Waiting for remote AI server…';
    try {
      const response = await fetch('/api/sms/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key.value },
        body,
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) {
        status.textContent = errorMessage(response.status);
        return;
      }
      const data = await response.json();
      if (data.messageId !== messageId || !['SCAM', 'SAFE', 'SUSPICIOUS'].includes(data.classification)
        || !['HIGH', 'MEDIUM', 'LOW'].includes(data.confidence)
        || typeof data.rationale !== 'string' || !data.rationale.trim()) {
        status.textContent = 'The AI server returned a malformed response.';
        return;
      }
      status.textContent = 'Analysis completed.';
      addResult('Source', 'Remote AI server (experimental)');
      addResult('Classification', data.classification);
      addResult('Confidence', data.confidence);
      addResult('Rationale', data.rationale);
    } catch (error) {
      status.textContent = error?.name === 'AbortError'
        ? 'Request timed out. Check that the Mac is awake.'
        : 'AI server unavailable. Check Wi-Fi and the Mac server.';
    } finally {
      clearTimeout(timeout);
      key.value = '';
      analyze.disabled = false;
    }
  }

  analyze.addEventListener('click', run);
  clear.addEventListener('click', clearInputs);
  window.addEventListener('pagehide', clearInputs);
  window.addEventListener('pageshow', (event) => { if (event.persisted) clearInputs(); });
})();
