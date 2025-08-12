// index.js
const express = require('express');
const fetch = require('node-fetch');
const { crawlerForDomains } = require('./crawler');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const JOBS = {}; // in-memory job store: { jobId: { status, events: [], results: Set, createdAt } }

// SSE endpoint pro průběžné zprávy
app.get('/events/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  if (!JOBS[jobId]) return res.status(404).send('Job not found');

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  // odešleme existující události (může být velké)
  (JOBS[jobId].events || []).forEach(evt => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });

  // uchovávej připojení
  JOBS[jobId].sseRes = res;

  // on close
  req.on('close', () => {
    if (JOBS[jobId]) JOBS[jobId].sseRes = null;
  });
});

// start job
// GET /start?source=<RAW_URL>&concurrency=200&maxPages=5&maxDepth=2
app.get('/start', async (req, res) => {
  const source = req.query.source;
  if (!source) return res.status(400).json({ error: 'source query param required' });

  // volitelné parametry
  const concurrency = parseInt(req.query.concurrency || '200', 10);
  const maxPagesPerDomain = parseInt(req.query.maxPages || '20', 10);
  const maxDepth = parseInt(req.query.maxDepth || '2', 10);

  const jobId = uuidv4();
  JOBS[jobId] = {
    status: 'queued',
    events: [],
    results: new Set(),
    createdAt: Date.now(),
    sseRes: null
  };

  // odešli okamžitou odpověď s jobId
  res.json({ jobId });

  // spuštění background jobu (nedojde k blokaci odpovědi)
  (async () => {
    try {
      sendEvent(jobId, { type: 'info', message: 'Stahuji seznam domén...' });
      // Ensure absolute URL for fetch
      let fetchUrl = source;
      try {
        // If it's not an absolute URL, try to prepend http://
        new URL(source);
      } catch {
        // No protocol: prepend http://
        fetchUrl = `http://${source}`;
      }
      const r = await fetch(fetchUrl);
      if (!r.ok) {
        sendEvent(jobId, { type: 'error', message: `Chyba při stahování source: ${r.status}` });
        JOBS[jobId].status = 'failed';
        return;
      }
      const text = await r.text();
      const domains = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      sendEvent(jobId, { type: 'info', message: `Načteno ${domains.length} domén. Spouštím crawler...` });

      JOBS[jobId].status = 'running';

      // spustit hlavní crawler pro seznam domén
      await crawlerForDomains({
        jobId,
        domains,
        concurrency,
        maxPagesPerDomain,
        maxDepth,
        onEvent: evt => sendEvent(jobId, evt),
        onFoundImage: imgUrl => JOBS[jobId].results.add(imgUrl)
      });

      JOBS[jobId].status = 'done';
      sendEvent(jobId, { type: 'done', message: `Hotovo. Nalezeno ${JOBS[jobId].results.size} unikátních obrazových URL.` });

    } catch (err) {
      console.error(err);
      sendEvent(jobId, { type: 'error', message: String(err) });
      JOBS[jobId].status = 'failed';
    }
  })();
});

// stáhni výsledky jako plain text
app.get('/results/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = JOBS[jobId];
  if (!job) return res.status(404).send('Job not found');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const arr = Array.from(job.results || []);
  res.send(arr.join('\n'));
});

function sendEvent(jobId, evt) {
  const job = JOBS[jobId];
  if (!job) return;
  job.events.push(evt);
  // cap event buffer to reasonable size
  if (job.events.length > 2000) job.events.shift();

  if (job.sseRes) {
    try {
      job.sseRes.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (e) {
      // ignore
    }
  }
}

// fallback ping
app.get('/', (req, res) => res.send('Crawler service ready. Use /start?source=RAW_URL'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Listening on', port));
