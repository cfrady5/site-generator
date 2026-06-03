import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 3;

function checkRateLimit(ip, email) {
  const now = Date.now();
  for (const key of [ip, email].filter(Boolean)) {
    const entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) { rateLimitStore.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS }); continue; }
    if (entry.count >= RATE_MAX) { const m = Math.ceil((entry.resetAt - now) / 60000); return { limited: true, message: `Too many submissions. Try again in ${m} minute${m !== 1 ? 's' : ''}.` }; }
    entry.count += 1;
  }
  return { limited: false };
}

// Validation
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const REQUIRED = ['name','email','businessName','businessDescription','services','tone','primaryColor','secondaryColor','accentColor','websiteGoal'];

function validateInput(body) {
  const errors = [];
  for (const f of REQUIRED) { if (!body[f] || String(body[f]).trim() === '') errors.push(`${f} is required.`); }
  if (errors.length) return errors;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('Invalid email address.');
  for (const f of ['primaryColor','secondaryColor','accentColor']) { if (body[f] && !HEX_RE.test(body[f])) errors.push(`${f} must be a hex color like #FF6B6B.`); }
  if ((body.businessDescription?.length||0) > 2000) errors.push('businessDescription max 2000 chars.');
  if ((body.businessName?.length||0) > 200) errors.push('businessName max 200 chars.');
  if ((body.services?.length||0) > 2000) errors.push('services max 2000 chars.');
  if ((body.websiteGoal?.length||0) > 200) errors.push('websiteGoal max 200 chars.');
  return errors;
}

// Naming
function safeSlug(n) { return n.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40); }
function makeProjectName(n) { return `client-${safeSlug(n)}-${Date.now().toString(36)}`; }
function b64(s) { return Buffer.from(s,'utf8').toString('base64'); }

// Claude generation
async function generateSiteFiles(f) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 12000,
      system: `You are a world-class web designer. Convert business briefs into polished landing pages.
Output exactly three sections with these exact delimiters, no markdown or commentary:
===HTML===
(complete index.html linking to styles.css and script.js)
===CSS===
(complete styles.css with :root color variables)
===JS===
(complete script.js or a comment if no JS needed)`,
      messages: [{ role: 'user', content: `Generate a professional website preview.

BUSINESS:
- Name: ${f.businessName}
- Owner: ${f.name} (${f.email})
- Description: ${f.businessDescription}
- Services: ${f.services}
- Goal: ${f.websiteGoal}
- Tone: ${f.tone}

BRAND COLORS (CSS custom properties):
  --color-primary:   ${f.primaryColor}
  --color-secondary: ${f.secondaryColor}
  --color-accent:    ${f.accentColor}

DESIGN REQUIREMENTS:
- Mobile-first, responsive at 375/768/1024/1440px
- Google Fonts matching the tone
- Transitions 150-300ms, prefers-reduced-motion respected
- WCAG AA contrast (4.5:1), cursor-pointer on interactive elements

SECTIONS (in order):
1. Sticky nav with anchor links
2. Hero: full-viewport gradient background (NO images), strong headline matching goal, CTA button
3. Services: responsive card grid, SVG/Unicode icons, 2-sentence descriptions
4. About: 2-3 paragraphs from the description
5. CTA banner: mid-page conversion nudge
6. Contact: show ONLY ${f.email} - no fake phone/address/testimonials
7. Footer: name + year

RULES:
- Zero Lorem Ipsum - every word reflects this actual business
- No invented contacts or testimonials
- Image placeholder: <div class="img-placeholder"><!-- IMAGE: description --></div>
- Call it a website preview not the final website
- HTML: valid HTML5, link styles.css, script.js at end of body
- CSS: define --color-primary/secondary/accent in :root
- JS: real interactivity only; if none: // No JavaScript required

Start with ===HTML===` }]
    })
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const raw = (await res.json()).content[0].text;
  const htmlMatch = raw.match(/===HTML===\s*([\s\S]*?)(?====CSS===|$)/);
  const cssMatch  = raw.match(/===CSS===\s*([\s\S]*?)(?====JS===|$)/);
  const jsMatch   = raw.match(/===JS===\s*([\s\S]*?)$/);
  if (!htmlMatch) throw new Error('Claude response missing ===HTML=== section');
  return { html: (htmlMatch[1]||'').trim(), css: (cssMatch?.[1]||'/* No styles */').trim(), js: (jsMatch?.[1]||'// No JavaScript required').trim() };
}

// GitHub
async function ghReq(path, method='GET', body=null) {
  const res = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function createGithubRepo(projectName, businessName, files) {
  const org = process.env.GITHUB_ORG;
  let endpoint;
  try { await ghReq(`/orgs/${org}`); endpoint = `/orgs/${org}/repos`; } catch { endpoint = '/user/repos'; }
  const repo = await ghReq(endpoint, 'POST', { name: projectName, description: `Website preview — ${businessName} — Frames by Frady`, private: false, auto_init: false });
  for (const { path, content } of files) {
    await ghReq(`/repos/${repo.full_name}/contents/${path}`, 'PUT', { message: 'feat: initial site preview — Frames by Frady', content: b64(content) });
  }
  return repo.full_name;
}

// Netlify
async function netlifyReq(path, method, body, isJson=true) {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.NETLIFY_TOKEN}`, 'Content-Type': isJson ? 'application/json' : 'application/octet-stream' },
    body: body ? (isJson ? JSON.stringify(body) : body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Netlify ${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function deployToNetlify(projectName, files) {
  const site = await netlifyReq('/sites', 'POST', { name: projectName, force_ssl: true });
  const fileDigests = {};
  const fileContents = {};
  for (const [filePath, content] of Object.entries(files)) {
    const buf = Buffer.from(content, 'utf8');
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    fileDigests[`/${filePath}`] = hash;
    fileContents[hash] = buf;
  }
  const deploy = await netlifyReq(`/sites/${site.id}/deploys`, 'POST', { files: fileDigests });
  for (const hash of (deploy.required || [])) {
    const buf = fileContents[hash];
    if (buf) await netlifyReq(`/deploys/${deploy.id}/files/${hash}`, 'PUT', buf, false);
  }
  return { siteUrl: `https://${site.subdomain}.netlify.app` };
}

// README
function makeReadme(f, projectName, siteUrl) {
  return `# ${f.businessName} — Website Preview
Generated by [Frames by Frady](https://framesbyfrady.com).

## Summary
| Field | Value |
|---|---|
| Client | ${f.name} (${f.email}) |
| Business | ${f.businessName} |
| Goal | ${f.websiteGoal} |
| Tone | ${f.tone} |

## Brand Colors
| | Hex |
|---|---|
| Primary | \`${f.primaryColor}\` |
| Secondary | \`${f.secondaryColor}\` |
| Accent | \`${f.accentColor}\` |

## Live Preview
${siteUrl}

## Files
- index.html, styles.css, script.js, README.md

## Notes
- Colors defined as CSS variables in styles.css :root
- Replace img-placeholder divs with real photos
- Connect custom domain in Netlify dashboard

*Preview/draft — final delivery may include further refinements.*`;
}

// Notify
async function notifyOwner(f, siteUrl, repoUrl) {
  const msg = `New preview: ${f.businessName}\nClient: ${f.name} (${f.email})\nPreview: ${siteUrl}\nRepo: ${repoUrl}`;
  console.log('[notify]', msg);
  if (process.env.NOTIFY_EMAIL && process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({ from:'generator@framesbyfrady.com', to:process.env.NOTIFY_EMAIL, subject:`New Preview: ${f.businessName}`, text:msg }) });
    } catch(e) { console.error('[notify] failed:', e.message); }
  }
}

// Route
app.post('/api/generate-site', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET)
    return res.status(401).json({ success:false, error:'Unauthorized', stepFailed:'auth' });

  const ip = (req.headers['x-forwarded-for']||req.ip||'').split(',')[0].trim();
  const email = req.body?.email?.toLowerCase().trim()||'';
  const limit = checkRateLimit(ip, email);
  if (limit.limited) return res.status(429).json({ success:false, error:limit.message, stepFailed:'rate_limit' });

  const errors = validateInput(req.body||{});
  if (errors.length) return res.status(400).json({ success:false, error:errors.join(' '), stepFailed:'validation' });

  const fields = Object.fromEntries(Object.entries(req.body).map(([k,v]) => [k, typeof v==='string' ? v.trim() : v]));
  const projectName = makeProjectName(fields.businessName);
  console.log(`[generate-site] Starting — "${fields.businessName}" → ${projectName}`);

  let siteFiles;
  try { console.log('[generate-site] Calling Claude...'); siteFiles = await generateSiteFiles(fields); }
  catch(err) { return res.status(500).json({ success:false, error:err.message, stepFailed:'generation' }); }

  let siteUrl;
  try { console.log('[generate-site] Deploying to Netlify...'); ({ siteUrl } = await deployToNetlify(projectName, { 'index.html':siteFiles.html, 'styles.css':siteFiles.css, 'script.js':siteFiles.js })); console.log(`[generate-site] Live: ${siteUrl}`); }
  catch(err) { return res.status(500).json({ success:false, error:err.message, stepFailed:'netlify_deploy' }); }

  let repoUrl = null;
  try {
    const readme = makeReadme(fields, projectName, siteUrl);
    const fullName = await createGithubRepo(projectName, fields.businessName, [
      { path:'index.html', content:siteFiles.html }, { path:'styles.css', content:siteFiles.css },
      { path:'script.js', content:siteFiles.js }, { path:'README.md', content:readme }
    ]);
    repoUrl = `https://github.com/${fullName}`;
  } catch(err) { console.error('[generate-site] GitHub failed (non-fatal):', err.message); }

  await notifyOwner(fields, siteUrl, repoUrl);

  return res.status(200).json({ success:true, businessName:fields.businessName, deploymentUrl:siteUrl, repoUrl, projectName });
});

app.get('/', (req, res) => res.json({ status:'ok', service:'Frames by Frady — Site Generator' }));
app.listen(PORT, () => console.log(`[server] Running on port ${PORT}`));
