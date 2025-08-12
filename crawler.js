// crawler.js
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const PQueue = require('p-queue').default;
const { URL } = require('url');

let playwright = null;
try {
  playwright = require('playwright'); // optional
} catch (e) {
  playwright = null;
}

/**
 * Hlavní orchestrátor pro zpracování seznamu domén.
 * options:
 *   jobId, domains, concurrency, maxPagesPerDomain, maxDepth, onEvent, onFoundImage
 */
async function crawlerForDomains(options) {
  const {
    domains,
    concurrency = 200,
    maxPagesPerDomain = 20,
    maxDepth = 2,
    onEvent = () => {},
    onFoundImage = () => {}
  } = options;

  const queue = new (PQueue)({ concurrency });

  onEvent({ type: 'info', message: `Crawl start: concurrency=${concurrency}, maxPagesPerDomain=${maxPagesPerDomain}, maxDepth=${maxDepth}` });

  let processedDomains = 0;

  // optional: prepare browser if playwright available
  let browser = null;
  if (playwright) {
    try {
      browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      onEvent({ type: 'info', message: 'Playwright available: JS rendering ON' });
    } catch (e) {
      browser = null;
      onEvent({ type: 'info', message: 'Playwright not usable in this environment, falling back to HTTP-only parsing' });
    }
  } else {
    onEvent({ type: 'info', message: 'Playwright not installed: JS rendering OFF' });
  }

  // worker for single domain
  async function handleDomain(domain) {
    const startUrl = `http://${domain}`;
    const host = domain.toLowerCase();
    const seen = new Set();
    const toVisit = [{ url: startUrl, depth: 0 }];
    let pagesVisited = 0;

    while (toVisit.length && pagesVisited < maxPagesPerDomain) {
      const { url, depth } = toVisit.shift();
      if (seen.has(url)) continue;
      seen.add(url);

      // fetch and parse (try plain fetch first)
      onEvent({ type: 'progress', message: `(${host}) fetching ${url} (depth ${depth})` });

      let html = null;
      try {
        let fetchUrl = url;
        try {
          new URL(url);
        } catch {
          // No protocol: prepend http://
          fetchUrl = `http://${url}`;
        }
        const r = await fetch(fetchUrl, { redirect: 'follow', timeout: 10000 });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok) {
          onEvent({ type: 'warn', message: `(${host}) ${url} -> HTTP ${r.status}` });
        }
        if (ct.includes('text/html')) {
          html = await r.text();
        } else {
          // not HTML: skip
          html = null;
        }
      } catch (e) {
        onEvent({ type: 'warn', message: `(${host}) fetch error ${url}: ${e.message}` });
        html = null;
      }

      // if HTML empty and browser available AND depth <= maxDepth, try rendering with Playwright
      if ((!html || html.length < 50) && browser) {
        try {
          const context = await browser.newContext();
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(()=>{});
          html = await page.content();
          await page.close();
          await context.close();
          onEvent({ type: 'info', message: `(${host}) rendered by browser: ${url}` });
        } catch (e) {
          onEvent({ type: 'warn', message: `(${host}) browser render failed: ${e.message}` });
        }
      }

      if (!html) {
        pagesVisited++;
        continue;
      }

      // extract images and links
      const { images, links } = extractImagesAndLinks(html, url);

      // emit found images
      for (const img of images) {
        onFoundImage(normalizeUrl(img, url));
      }

      // enqueue internal links if depth < maxDepth
      if (depth < maxDepth) {
        for (const link of links) {
          try {
            const u = new URL(link, url);
            // keep scheme http/https and same host
            if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.toLowerCase().endsWith(host)) {
              const normalized = u.href.split('#')[0];
              if (!seen.has(normalized)) {
                toVisit.push({ url: normalized, depth: depth + 1 });
              }
            }
          } catch (e) {
            // ignore invalid url
          }
        }
      }

      pagesVisited++;
      // periodic progress event per domain
      if (pagesVisited % 5 === 0) {
        onEvent({ type: 'domain-progress', domain: host, pagesVisited });
      }
    } // end while

    processedDomains++;
    onEvent({ type: 'domain-done', domain: host, processedDomains });
  }

  // push domain handlers into queue
  for (const d of domains) {
    queue.add(() => handleDomain(d));
  }

  await queue.onIdle(); // wait until all done

  if (browser) {
    try { await browser.close(); } catch(e) {}
  }

  onEvent({ type: 'info', message: 'All domains processed' });
}

function extractImagesAndLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const images = new Set();
  const links = new Set();

  // img src and srcset
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src) images.add(src);
    const srcset = $(el).attr('srcset');
    if (srcset) {
      srcset.split(',').forEach(part => {
        const url = part.trim().split(' ')[0];
        if (url) images.add(url);
      });
    }
  });

  // background-image in inline style
  $('[style]').each((i, el) => {
    const s = $(el).attr('style');
    const regex = /background(-image)?\s*:\s*url\(([^)]+)\)/ig;
    let m;
    while ((m = regex.exec(s)) !== null) {
      let url = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (url) images.add(url);
    }
  });

  // link rel preloads or meta images
  $('link[rel="preload"], link[rel="prefetch"], meta[property="og:image"]').each((i, el) => {
    const href = $(el).attr('href') || $(el).attr('content');
    if (href) images.add(href);
  });

  // gather internal links (a[href])
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) links.add(href);
  });

  return { images: Array.from(images), links: Array.from(links) };
}

function normalizeUrl(u, base) {
  try {
    return new URL(u, base).href;
  } catch (e) {
    return u;
  }
}

module.exports = { crawlerForDomains };
