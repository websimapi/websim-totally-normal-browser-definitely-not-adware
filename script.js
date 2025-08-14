// Utilities and global state
const frame = document.getElementById('mainFrame');
const catcher = document.getElementById('interaction-catcher');
const adEl = document.getElementById('ad-layer');
const adClose = document.getElementById('ad-close');
const adImg = document.getElementById('ad-image');
const adHeadline = document.getElementById('ad-headline');
const adSub = document.getElementById('ad-sub');
const adCta = document.getElementById('ad-cta');
const statusMsg = document.getElementById('status-msg');

/* ...existing code... */
let interactionTimer = null;
let adVisible = false;
let lastInteractionAt = 0;
let nextAdDueAt = 0;
let adTargets = []; // { url, commentSnippet }
let creativeCache = []; // { url, headline, sub, image }
let cursor = null;
let loadingTargets = false;
let initialized = false;

/* Chance config */
const chanceToAdOnCycle = 0.75; // 75% chance after each wait period
const minDelay = 3000;
const maxDelay = 7000;

/* Fallback targets if no comments found */
const fallbackTargets = [
  { url: 'https://websim.ai', commentSnippet: 'Explore fresh AI creations now' },
  { url: 'https://websim.com/explore', commentSnippet: 'Top trending projects here' },
  { url: 'https://websim.com', commentSnippet: 'What will you build next?' }
];

/* Initialize everything */
(async function init() {
  if (initialized) return;
  initialized = true;
  status('Booting...');

  // Preload targets from comments
  await ensureTargets(120);

  // Listen for new comments in real-time to enrich pool
  if (window.websim?.addEventListener) {
    window.websim.addEventListener('comment:created', (data) => {
      const c = data?.comment;
      if (!c?.raw_content) return;
      const urls = extractUrls(c.raw_content);
      const valid = urls.filter(isValidTargetUrl);
      valid.forEach(u => {
        adTargets.push({ url: u, commentSnippet: snippetFromComment(c.raw_content) });
      });
      // trim
      if (adTargets.length > 800) adTargets.splice(0, adTargets.length - 800);
    });
  }

  // Interaction catcher: capture click, then immediately let pointer pass to iframe
  catcher.addEventListener('pointerdown', onUserInteraction, { passive: true });
  catcher.addEventListener('pointermove', onUserInteraction, { passive: true });
  document.addEventListener('keydown', onUserInteraction, { passive: true });

  // Ad click mechanics
  adClose.addEventListener('click', (e) => {
    e.stopPropagation();
    hideAd();
    status('Nice try. Closed one.');
  });

  // Clicking the ad body or CTA navigates the iframe to the ad's URL
  adEl.addEventListener('click', (e) => {
    if (e.target === adClose) return; // handled above
    const url = adEl.getAttribute('data-url');
    if (url) navigateIframe(url);
  });
  adCta.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = adEl.getAttribute('data-url');
    if (url) navigateIframe(url);
  });

  // Pre-generate a couple creatives in background
  warmCreatives(2);

  status('Ready. Click anywhere to browse...');
})();

/* Interaction handling */
function onUserInteraction() {
  // Let this event count as a "click-through" to iframe after we detect it
  // Temporarily disable catcher so the next immediate event reaches iframe
  catcher.style.pointerEvents = 'none';
  setTimeout(() => { catcher.style.pointerEvents = 'auto'; }, 0);

  const now = Date.now();
  lastInteractionAt = now;

  if (now >= nextAdDueAt) {
    scheduleAdCycle();
  }
}

function scheduleAdCycle() {
  clearTimeout(interactionTimer);
  const delay = randInt(minDelay, maxDelay);
  nextAdDueAt = Date.now() + delay;
  interactionTimer = setTimeout(async () => {
    if (Math.random() < chanceToAdOnCycle) {
      // Ensure we have targets
      await ensureTargets(120);
      // Show an ad (use cache when possible)
      let creative = creativeCache.length ? creativeCache.shift() : await buildCreative();
      if (!creative) return scheduleAdCycle(); // try again later
      showAd(creative);
      // keep pipeline warm
      warmCreatives(1);
    }
    // Schedule another cycle after the next interaction
  }, delay);
}

/* Targets and comments loading */
async function ensureTargets(minCount = 100) {
  if (adTargets.length >= minCount || loadingTargets) return;
  loadingTargets = true;
  try {
    const proj = await safeGetProject();
    if (!proj) { mergeFallbackTargets(); return; }
    let params = new URLSearchParams({ first: '100' });
    let keepGoing = true, pageCount = 0;
    while (keepGoing && adTargets.length < minCount && pageCount < 10) {
      const resp = await fetch(`/api/v1/projects/${proj.id}/comments?` + params.toString());
      const data = await resp.json();
      consumeComments(data?.comments?.data ?? []);
      const meta = data?.comments?.meta;
      params = meta?.end_cursor ? new URLSearchParams({ after: meta.end_cursor, first: '100' }) : params;
      keepGoing = !!meta?.has_next_page; pageCount++;
    }
    if (adTargets.length < 5) await ensureMetaTargets(); // digested all pages; use metadata
  } catch (e) {
    console.warn('Failed to load comments, using fallback', e);
    await ensureMetaTargets();
  } finally {
    loadingTargets = false;
  }
}

async function ensureMetaTargets() {
  try {
    const proj = await safeGetProject();
    const owner = await window.websim?.getCreator?.();
    if (proj?.id) {
      const projUrl = `https://websim.com/p/${proj.id}`;
      const title = proj?.title || 'A Websim Project';
      const desc = (proj?.description || '').slice(0, 120) || 'Open to explore this creation.';
      if (!adTargets.find(t => t.url === projUrl)) adTargets.push({ url: projUrl, commentSnippet: `${title} — ${desc}`, fromMeta: true });
    }
    if (owner?.username) {
      const profileUrl = `https://websim.com/@${owner.username}`;
      if (!adTargets.find(t => t.url === profileUrl)) adTargets.push({ url: profileUrl, commentSnippet: `Discover more from @${owner.username}`, fromMeta: true });
    }
  } catch { /* ignore */ }
  mergeFallbackTargets();
}

function consumeComments(items) {
  for (const item of items) {
    const c = item?.comment;
    if (!c?.raw_content) continue;
    const urls = extractUrls(c.raw_content);
    const valid = urls.filter(isValidTargetUrl);
    if (!valid.length) continue;
    const snip = snippetFromComment(c.raw_content);
    valid.forEach(u => adTargets.push({ url: u, commentSnippet: snip }));
  }
  // Deduplicate by url, keep latest
  const map = new Map();
  for (const t of adTargets) map.set(t.url, t);
  adTargets = Array.from(map.values());
}

function mergeFallbackTargets() {
  for (const f of fallbackTargets) {
    if (!adTargets.find(t => t.url === f.url)) adTargets.push(f);
  }
}

/* Creative generation */
async function buildCreative() {
  if (!adTargets.length) await ensureMetaTargets();
  if (!adTargets.length) return null;
  const target = adTargets[randInt(0, adTargets.length - 1)];
  const base = {
    url: target.url,
    headline: target.fromMeta ? 'Peek behind this project.' : 'You won’t believe what’s inside.',
    sub: target.commentSnippet || 'Tap to unlock the surprise.',
    image: ''
  };

  try {
    // Get a clickbait headline and sub with websim.chat
    const system = 'You craft short, punchy, playful clickbait for ads. Keep it clean. Return JSON only.';
    const prompt = `Create a clickbait headline and subhead for an invasive overlay ad. The user might be redirected to: ${target.url}.
Context from a comment: ${target.commentSnippet || 'No extra context'}.
Respond exactly as:
{"headline": string, "sub": string}`;
    const completion = await window.websim?.chat?.completions?.create({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text: prompt }] }
      ],
      json: true
    });
    if (completion?.content) {
      const out = JSON.parse(completion.content);
      if (out?.headline) base.headline = out.headline.slice(0, 100);
      if (out?.sub) base.sub = out.sub.slice(0, 140);
    }
  } catch (e) {
    // ignore; use defaults
  }

  try {
    // Generate a fun teaser image
    const imgPrompt = `Clean, minimalist ad teaser, high contrast, product preview card, subtle lighting, white background. Theme inspired by: ${target.url}.`;
    const img = await window.websim?.imageGen?.({ prompt: imgPrompt, aspect_ratio: '5:4' });
    if (img?.url) base.image = img.url;
  } catch (e) {
    // fallback: empty -> gray block shows
  }

  return base;
}

async function warmCreatives(n = 1) {
  const tasks = [];
  for (let i = 0; i < n; i++) tasks.push(buildCreative());
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) creativeCache.push(r.value);
  }
  // keep cache small
  if (creativeCache.length > 4) creativeCache.splice(4);
}

/* Ad presentation */
function showAd(creative) {
  if (!creative) return;
  adVisible = true;
  adEl.setAttribute('data-url', creative.url);
  adHeadline.textContent = creative.headline || 'Breaking: You missed this!';
  adSub.textContent = creative.sub || 'Click to open.';
  if (creative.image) {
    adImg.src = creative.image;
  } else {
    adImg.removeAttribute('src');
  }
  adEl.classList.remove('hidden');

  // Position randomly and sometimes float
  randomPlaceAd();
  maybeToggleFloat();

  // Reposition a few times while visible
  scheduleRandomMoves();
  status('Ad popped. Try to close it...');
}

function hideAd() {
  adVisible = false;
  adEl.classList.add('hidden');
  adEl.removeAttribute('data-url');
  // stop float
  adEl.classList.remove('floaty');
}

function randomPlaceAd() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const w = Math.min(420, Math.floor(vw * 0.88));
  const h = 320; // approx
  const x = randInt(10, Math.max(10, vw - w - 10));
  const y = randInt(10, Math.max(10, vh - h - 10));

  adEl.style.left = `${x}px`;
  adEl.style.top = `${y}px`;
}

function scheduleRandomMoves() {
  let moves = randInt(2, 5);
  const hop = () => {
    if (!adVisible) return;
    randomPlaceAd();
    moves--;
    if (moves > 0) setTimeout(hop, randInt(1200, 2500));
  };
  setTimeout(hop, randInt(800, 1600));
}

function maybeToggleFloat() {
  if (Math.random() < 0.6) adEl.classList.add('floaty');
  else adEl.classList.remove('floaty');
}

/* Navigation consequence if user clicks the ad (not the X) */
function navigateIframe(url) {
  try {
    frame.src = url;
    hideAd();
    status('Redirected you. Oops!');
  } catch (e) {
    console.warn('Failed to navigate iframe', e);
  }
}

/* Helpers */
function extractUrls(markdown) {
  // match plain URLs and markdown links
  const urls = new Set();
  const urlRegex = /https?:\/\/[^\s)]+/gi;
  const mdLinkRegex = /\((https?:\/\/[^)]+)\)/g;

  let m;
  while ((m = urlRegex.exec(markdown)) !== null) urls.add(m[0]);
  while ((m = mdLinkRegex.exec(markdown)) !== null) urls.add(m[1]);

  return Array.from(urls);
}

function isValidTargetUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname.endsWith('websim.com') || url.hostname.endsWith('websim.ai');
  } catch {
    return false;
  }
}

function snippetFromComment(raw) {
  return (raw || '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // remove images
    .replace(/\[[^\]]*\]\([^)]+\)/g, '') // remove links but keep text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function status(msg) {
  statusMsg.textContent = msg;
  // brief highlight
  statusMsg.style.opacity = '0.65';
  setTimeout(() => (statusMsg.style.opacity = '1'), 220);
}

async function safeGetProject() {
  try {
    const proj = await window.websim?.getCurrentProject?.();
    return proj || null;
  } catch {
    return null;
  }
}