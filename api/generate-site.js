/**
 * Frames by Frady — Site Generator Webhook
 * Deploy as: api/generate-site.js in a Vercel project
 *
 * Required env vars (set in Vercel dashboard — NEVER in frontend code):
 *   WEBHOOK_SECRET      - Secret string your form sends in X-Webhook-Secret header
 *   ANTHROPIC_API_KEY   - Claude API key
 *   GITHUB_TOKEN        - GitHub PAT with "repo" scope
 *   GITHUB_ORG          - GitHub username or org (e.g. "framesbyfrady")
 *   VERCEL_TOKEN        - Vercel API token
 *   VERCEL_TEAM_ID      - (optional) Vercel team ID if on a team plan
 *   NOTIFY_EMAIL        - (optional) your email to receive deployment notifications
 *   RESEND_API_KEY      - (optional) Resend.com API key for owner notifications
 */

export const config = { maxDuration: 60 };

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
const rateLimitStore = new Map();

function checkRateLimit(ip, email) {
  const now = Date.now();
  const keys = [ip, email].filter(Boolean);
  for (const key of keys) {
    const entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      continue;
    }
    if (entry.count >= RATE_LIMIT_MAX) {
      const minutesLeft = Math.ceil((entry.resetAt - now) / 60000);
      return { limited: true, message: `Too many submissions. Please wait ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''} before trying again.` };
    }
    entry.count += 1;
  }
  return { limited: false };
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const MAX_TEXT_LEN = 2000;
const MAX_SHORT_LEN = 200;
const REQUIRED_FIELDS = ['name','email','businessName','businessDescription','services','tone','primaryColor','secondaryColor','accentColor','websiteGoal'];

function validateInput(body) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') errors.push(`${field} is required.`);
  }
  if (errors.length) return errors;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('email must be a valid email address.');
  for (const colorField of ['primaryColor', 'secondaryColor', 'accentColor']) {
    if (body[colorField] && !HEX_COLOR_RE.test(body[colorField])) errors.push(`${colorField} must be a valid 6-digit hex color (e.g. #FF6B6B).`);
  }
  if (body.businessDescription?.length > MAX_TEXT_LEN) errors.push(`businessDescription must be ${MAX_TEXT_LEN} characters or fewer.`);
  if (body.businessName?.length > MAX_SHORT_LEN) errors.push(`businessName must be ${MAX_SHORT_LEN} characters or fewer.`);
  if (body.services?.length > MAX_TEXT_LEN) errors.push(`services must be ${MAX_TEXT_LEN} characters or fewer.`);
  if (body.websiteGoal?.length > MAX_SHORT_LEN) errors.push(`websiteGoal must be ${MAX_SHORT_LEN} characters or fewer.`);
  return errors;
}

function safeSlug(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function makeProjectName(businessName) {
  return `client-${safeSlug(businessName)}-${Date.now().toString(36)}`;
}

function b64(str) { return Buffer.from(str, 'utf8').toString('base64'); }

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function githubRequest(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function vercelRequest(path, method = 'GET', body = null) {
  const sep = path.includes('?') ? '&' : '?';
  const teamSuffix = process.env.VERCEL_TEAM_ID ? `${sep}teamId=${process.env.VERCEL_TEAM_ID}` : '';
  const res = await fetch(`https://api.vercel.com${path}${teamSuffix}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vercel ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function generateSiteFiles(fields) {
  const { businessName, businessDescription, services, primaryColor, secondaryColor, accentColor, tone, websiteGoal, name, email } = fields;

  const systemPrompt = `You are a world-class web designer and developer specializing in converting business briefs into polished, production-ready landing pages.

You output exactly three files separated by delimiter lines. No markdown fences, no commentary, no extra text.

Format:
===HTML===
(complete index.html — structure only, link to styles.css and script.js)
===CSS===
(complete styles.css content)
===JS===
(complete script.js content — may be empty if no JS is needed, but the delimiter must still appear)`;

  const userPrompt = `Generate a professional website preview for this business.

BUSINESS BRIEF:
- Business Name: ${businessName}
- Owner: ${name} (${email})
- Description: ${businessDescription}
- Services: ${services}
- Website Goal: ${websiteGoal}
- Tone / Brand Voice: ${tone}

BRAND COLORS (use as CSS custom properties):
  --color-primary:   ${primaryColor}
  --color-secondary: ${secondaryColor}
  --color-accent:    ${accentColor}

DESIGN REQUIREMENTS:
- Mobile-first, fully responsive (375px, 768px, 1024px, 1440px breakpoints)
- CSS custom properties for all brand colors
- Google Fonts matching the tone
- Smooth scroll, hover transitions 150-300ms
- prefers-reduced-motion respected
- WCAG AA contrast minimum 4.5:1
- cursor-pointer on interactive elements
- Focus states visible for keyboard nav

PAGE SECTIONS:
1. Sticky nav with logo and anchor links
2. Hero: full-viewport, strong headline matching websiteGoal, CTA button, CSS gradient background (NO images)
3. Services: responsive card grid, one per service, SVG icon or Unicode, title, 2-sentence description
4. About / Brand Story: 2-3 paragraphs from the description
5. CTA Banner: mid-page conversion nudge
6. Contact: show ONLY ${email} — no fake phone, address, or testimonials
7. Footer: business name and year

CONTENT RULES:
- Every word reflects the ACTUAL business — zero Lorem Ipsum
- Do NOT invent testimonials, fake contacts, or fake staff
- Image placeholders: styled div with comment: <!-- IMAGE: description -->
- No copyrighted images
- Call it a website preview or draft site — not the final website

HTML: Valid HTML5, link to styles.css and script.js at end of body. Semantic tags.
CSS: All styles in styles.css. Define :root with --color-primary: ${primaryColor}; --color-secondary: ${secondaryColor}; --color-accent: ${accentColor};
JS: Only real interactivity. If none needed: // No JavaScript required for this page

Output only the three delimited sections starting with ===HTML===`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 12000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.content[0].text;

  const htmlMatch = raw.match(/===HTML===\s*([\s\S]*?)(?====CSS===|$)/);
  const cssMatch  = raw.match(/===CSS===\s*([\s\S]*?)(?====JS===|$)/);
  const jsMatch   = raw.match(/===JS===\s*([\s\S]*?)$/);

  if (!htmlMatch) throw new Error('Claude response missing ===HTML=== section');
  return {
    html: (htmlMatch[1] || '').trim(),
    css:  (cssMatch?.[1] || '/* No styles */').trim(),
    js:   (jsMatch?.[1]  || '// No JavaScript required for this page').trim(),
  };
}

function generateReadme(fields, projectName, deploymentUrl) {
  return `# ${fields.businessName} — Website Preview

Generated by [Frames by Frady](https://framesbyfrady.com) as a **draft website preview**.

## Form Summary
| Field | Value |
|---|---|
| Client | ${fields.name} (${fields.email}) |
| Business | ${fields.businessName} |
| Goal | ${fields.websiteGoal} |
| Tone | ${fields.tone} |

## Brand Colors
| Variable | Hex |
|---|---|
| Primary | \`${fields.primaryColor}\` |
| Secondary | \`${fields.secondaryColor}\` |
| Accent | \`${fields.accentColor}\` |

## Live Preview
${deploymentUrl}

## Files
- index.html — page structure
- styles.css — all styling + brand color CSS variables
- script.js  — interactivity
- README.md  — this file

## Notes
- Brand colors are CSS custom properties in styles.css :root — change once, updates everywhere
- Replace image placeholders with real photos
- Add custom domain in Vercel dashboard

*This is a preview/draft. Final delivery may include further refinements.*`;
}

async function createRepo(projectName, businessName) {
  const org = process.env.GITHUB_ORG;
  let endpoint;
  try { await githubRequest(`/orgs/${org}`); endpoint = `/orgs/${org}/repos`; }
  catch { endpoint = '/user/repos'; }
  const repo = await githubRequest(endpoint, 'POST', {
    name: projectName,
    description: `Website preview for ${businessName} — generated by Frames by Frady`,
    private: false, auto_init: false,
  });
  return repo.full_name;
}

async function pushFiles(repoFullName, files) {
  for (const { path, content } of files) {
    await githubRequest(`/repos/${repoFullName}/contents/${path}`, 'PUT', {
      message: 'feat: initial site preview — generated by Frames by Frady',
      content: b64(content),
    });
  }
}

async function deployRepo(repoFullName, projectName) {
  const project = await vercelRequest('/v10/projects', 'POST', {
    name: projectName, framework: null,
    gitRepository: { type: 'github', repo: repoFullName },
  });
  const deployment = await vercelRequest('/v13/deployments', 'POST', {
    name: projectName, projectId: project.id,
    gitSource: { type: 'github', repo: repoFullName, ref: 'main' },
    target: 'production',
  });
  return { deploymentUrl: `https://${deployment.url}`, projectUrl: `https://${projectName}.vercel.app` };
}

async function notifyOwner(fields, repoUrl, deploymentUrl, projectName) {
  const summary = `New preview: ${fields.businessName}\nClient: ${fields.name} (${fields.email})\nURL: ${deploymentUrl}\nRepo: ${repoUrl}`;
  console.log('[notify-owner]', summary);
  if (process.env.NOTIFY_EMAIL && process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'generator@framesbyfrady.com', to: process.env.NOTIFY_EMAIL, subject: `New Preview: ${fields.businessName}`, text: summary }),
      });
    } catch (err) { console.error('[notify-owner] Email failed:', err.message); }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://framesbyfrady.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed', stepFailed: 'auth' });

  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized', stepFailed: 'auth' });
  }

  const ip = getClientIP(req);
  const emailForLimit = req.body?.email?.toLowerCase().trim() || '';
  const rateCheck = checkRateLimit(ip, emailForLimit);
  if (rateCheck.limited) return res.status(429).json({ success: false, error: rateCheck.message, stepFailed: 'rate_limit' });

  const body = req.body || {};
  const errors = validateInput(body);
  if (errors.length) return res.status(400).json({ success: false, error: errors.join(' '), stepFailed: 'validation' });

  const fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const projectName = makeProjectName(fields.businessName);
  let repoFullName, deploymentUrl, projectUrl;

  console.log(`[generate-site] Starting — "${fields.businessName}" → ${projectName}`);

  let siteFiles;
  try { siteFiles = await generateSiteFiles(fields); }
  catch (err) { return res.status(500).json({ success: false, error: err.message, stepFailed: 'generation' }); }

  try { repoFullName = await createRepo(projectName, fields.businessName); }
  catch (err) { return res.status(500).json({ success: false, error: err.message, stepFailed: 'github_create' }); }

  try {
    const readme = generateReadme(fields, projectName, `https://${projectName}.vercel.app`);
    await pushFiles(repoFullName, [
      { path: 'index.html', content: siteFiles.html },
      { path: 'styles.css', content: siteFiles.css },
      { path: 'script.js',  content: siteFiles.js },
      { path: 'README.md',  content: readme },
    ]);
  } catch (err) { return res.status(500).json({ success: false, error: err.message, stepFailed: 'github_push' }); }

  try { ({ deploymentUrl, projectUrl } = await deployRepo(repoFullName, projectName)); }
  catch (err) { return res.status(500).json({ success: false, error: err.message, stepFailed: 'vercel_deploy' }); }

  const repoUrl = `https://github.com/${repoFullName}`;
  await notifyOwner(fields, repoUrl, deploymentUrl, projectName);

  console.log(`[generate-site] Done! ${projectUrl}`);
  return res.status(200).json({ success: true, businessName: fields.businessName, repoUrl, deploymentUrl: projectUrl, projectName });
}
