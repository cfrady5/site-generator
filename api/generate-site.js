const REQUIRED_FIELDS = [
  "name",
  "email",
  "businessName",
  "businessDescription",
  "services",
  "tone",
  "primaryColor",
  "secondaryColor",
  "accentColor",
  "websiteGoal",
];

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const OWNER_EMAIL = process.env.OWNER_EMAIL || process.env.NOTIFY_EMAIL || "contact@framesbyfrady.com";
const FROM_EMAIL = process.env.FROM_EMAIL || "Frames by Frady <no-reply@framesbyfrady.com>";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed. Use POST.",
      stepFailed: "method_check",
    });
  }

  const startedAt = new Date().toISOString();
  let payload = null;

  try {
    const secret = req.headers["x-webhook-secret"];

    if (!process.env.WEBHOOK_SECRET) {
      return sendJson(res, 500, {
        success: false,
        error: "WEBHOOK_SECRET is not configured.",
        stepFailed: "environment_check",
      });
    }

    if (secret !== process.env.WEBHOOK_SECRET) {
      return sendJson(res, 401, {
        success: false,
        error: "Unauthorized.",
        stepFailed: "authorization",
      });
    }

    assertEnv(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GITHUB_ORG", "VERCEL_TOKEN"]);

    payload = await readJsonBody(req);
    const cleaned = normalizeSubmission(payload);
    validateSubmission(cleaned);

    const projectName = createProjectName(cleaned.businessName);
    const files = await generateWebsiteFiles(cleaned);

    const repo = await createGitHubRepository(projectName, cleaned.businessName);
    await uploadFilesToGitHub(repo.owner, repo.name, files);

    const deployment = await createVercelDeployment(projectName, files, cleaned.businessName);

    const result = {
      success: true,
      businessName: cleaned.businessName,
      projectName,
      repoUrl: repo.htmlUrl,
      deploymentUrl: deployment.url,
      deploymentId: deployment.id || null,
      submittedAt: cleaned.submittedAt || startedAt,
      completedAt: new Date().toISOString(),
    };

    await sendReadyForReviewEmail(cleaned, result).catch((error) => {
      console.error("Ready-for-review email failed:", error);
    });

    return sendJson(res, 200, result);
  } catch (error) {
    console.error("Website launcher error:", error);

    const stepFailed = error.stepFailed || "unknown";
    const message = error.message || "Website generation failed.";

    if (payload) {
      await sendErrorEmail(payload, stepFailed, message).catch((emailError) => {
        console.error("Error notification email failed:", emailError);
      });
    }

    return sendJson(res, error.statusCode || 500, {
      success: false,
      error: message,
      stepFailed,
    });
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function assertEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) {
    throw makeError(`Missing environment variables: ${missing.join(", ")}`, "environment_check", 500);
  }
}

function normalizeSubmission(input) {
  const trim = (value) => (typeof value === "string" ? value.trim() : "");

  return {
    source: trim(input.source) || "framesbyfrady-website-launcher",
    submittedAt: trim(input.submittedAt) || new Date().toISOString(),
    name: trim(input.name),
    email: trim(input.email),
    businessName: trim(input.businessName),
    currentWebsite: trim(input.currentWebsite),
    businessDescription: limitText(trim(input.businessDescription), 3000),
    services: limitText(trim(input.services), 1200),
    tone: trim(input.tone),
    tagline: limitText(trim(input.tagline), 240),
    websiteContactInfo: limitText(trim(input.websiteContactInfo), 1000),
    primaryColor: trim(input.primaryColor),
    secondaryColor: trim(input.secondaryColor),
    accentColor: trim(input.accentColor),
    budgetRange: trim(input.budgetRange),
    timeline: trim(input.timeline),
    websiteGoal: trim(input.websiteGoal),
    extraNotes: limitText(trim(input.extraNotes), 1500),
  };
}

function validateSubmission(body) {
  for (const field of REQUIRED_FIELDS) {
    if (!body[field]) {
      throw makeError(`Missing required field: ${field}`, "validation", 400);
    }
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email);
  if (!emailOk) throw makeError("Invalid email address.", "validation", 400);

  for (const field of ["primaryColor", "secondaryColor", "accentColor"]) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(body[field])) {
      throw makeError(`Invalid hex color: ${field}`, "validation", 400);
    }
  }
}

function limitText(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function makeError(message, stepFailed, statusCode = 500) {
  const error = new Error(message);
  error.stepFailed = stepFailed;
  error.statusCode = statusCode;
  return error;
}

function createProjectName(businessName) {
  const slug = businessName
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "website-preview";

  const suffix = Date.now().toString(36);
  return `client-${slug}-${suffix}`.slice(0, 63);
}

async function generateWebsiteFiles(submission) {
  const prompt = buildClaudePrompt(submission);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 8000,
      temperature: 0.35,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw makeError(
      `Claude generation failed: ${data?.error?.message || response.statusText}`,
      "claude_generation",
      502
    );
  }

  const text = extractClaudeText(data);
  const parsed = parseGeneratedFiles(text);

  return {
    "index.html": parsed.files["index.html"],
    "styles.css": parsed.files["styles.css"],
    "script.js": parsed.files["script.js"] || "",
    "README.md": buildGeneratedReadme(submission),
  };
}

function extractClaudeText(data) {
  const parts = data?.content || [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseGeneratedFiles(text) {
  const withoutFences = text
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw makeError("Claude did not return valid JSON files.", "claude_generation", 502);
  }

  const jsonText = withoutFences.slice(firstBrace, lastBrace + 1);
  let parsed;

  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw makeError("Claude returned malformed JSON.", "claude_generation", 502);
  }

  if (!parsed.files || !parsed.files["index.html"] || !parsed.files["styles.css"]) {
    throw makeError("Claude response was missing index.html or styles.css.", "claude_generation", 502);
  }

  return parsed;
}

function buildClaudePrompt(submission) {
  return `You are a senior web designer and frontend developer creating a polished static website preview for Frames by Frady.

Return ONLY valid JSON. Do not include markdown fences, commentary, explanations, or extra text.

The JSON shape must be exactly:
{
  "files": {
    "index.html": "complete HTML string",
    "styles.css": "complete CSS string",
    "script.js": "small optional JavaScript string"
  }
}

Build a complete, premium, mobile-first one-page landing page. Use semantic HTML, clean CSS, and only vanilla JavaScript if needed.

Business submission:
- Client name: ${submission.name}
- Client email: ${submission.email}
- Business name: ${submission.businessName}
- Current website: ${submission.currentWebsite || "Not provided"}
- Business description: ${submission.businessDescription}
- Services / offerings: ${submission.services}
- Preferred tone: ${submission.tone}
- Tagline or one-liner: ${submission.tagline || "Create one from the description"}
- Website contact info to include: ${submission.websiteContactInfo || "Only include contact info if clearly provided"}
- Primary brand color: ${submission.primaryColor}
- Secondary brand color: ${submission.secondaryColor}
- Accent brand color: ${submission.accentColor}
- Budget range: ${submission.budgetRange || "Not provided"}
- Timeline: ${submission.timeline || "Not provided"}
- Website goal: ${submission.websiteGoal}
- Extra notes: ${submission.extraNotes || "None"}

Design requirements:
- Use the selected brand colors as CSS variables: --primary, --secondary, --accent.
- Create a strong hero section with a clear headline and CTA.
- Include a services section using the provided services.
- Include an about / brand story section based only on the submitted description.
- Include a trust / credibility section, but do not invent awards, certifications, testimonials, client names, addresses, phone numbers, or reviews.
- Include a final CTA section.
- Include a contact section using only the provided contact info. If none is provided, use a generic CTA form placeholder without fake details.
- Use sophisticated spacing, strong typography, crisp cards, and responsive behavior.
- Do not use external images, copyrighted assets, icon libraries, CDNs, tracking scripts, or external fonts.
- Use placeholder visual blocks, gradients, abstract shapes, or CSS-only elements where imagery would go.
- Keep the code self-contained and deployable as static files.
- Make the result feel like a real client preview, not a template.
- In the footer, include: "Website preview generated by Frames by Frady."`;
}

function buildGeneratedReadme(submission) {
  return `# ${submission.businessName} Website Preview

Generated by Frames by Frady Website Launcher.

## Submission Summary

- Client: ${submission.name}
- Email: ${submission.email}
- Business: ${submission.businessName}
- Current Website: ${submission.currentWebsite || "Not provided"}
- Tone: ${submission.tone}
- Website Goal: ${submission.websiteGoal}
- Budget: ${submission.budgetRange || "Not provided"}
- Timeline: ${submission.timeline || "Not provided"}

## Brand Colors

- Primary: ${submission.primaryColor}
- Secondary: ${submission.secondaryColor}
- Accent: ${submission.accentColor}

## Services

${submission.services}

## Notes

${submission.extraNotes || "No extra notes provided."}
`;
}

async function createGitHubRepository(projectName, businessName) {
  const owner = process.env.GITHUB_ORG;
  const useOrgEndpoint = process.env.GITHUB_CREATE_IN_ORG === "true";
  const endpoint = useOrgEndpoint
    ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`
    : "https://api.github.com/user/repos";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      description: `Website preview for ${businessName}`,
      private: true,
      auto_init: false,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw makeError(
      `GitHub repo creation failed: ${data?.message || response.statusText}`,
      "github_repo_creation",
      502
    );
  }

  const [repoOwner, repoName] = data.full_name.split("/");

  return {
    owner: repoOwner,
    name: repoName,
    htmlUrl: data.html_url,
  };
}

async function uploadFilesToGitHub(owner, repo, files) {
  for (const [path, content] of Object.entries(files)) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Add ${path}`,
          content: Buffer.from(content, "utf8").toString("base64"),
        }),
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw makeError(
        `GitHub file upload failed for ${path}: ${data?.message || response.statusText}`,
        "github_file_upload",
        502
      );
    }
  }
}

async function createVercelDeployment(projectName, files, businessName) {
  const query = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";

  const response = await fetch(`https://api.vercel.com/v13/deployments${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      target: "production",
      projectSettings: {
        framework: null,
      },
      files: Object.entries(files).map(([file, data]) => ({ file, data })),
      meta: {
        source: "framesbyfrady-site-generator",
        businessName,
      },
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw makeError(
      `Vercel deployment failed: ${data?.error?.message || data?.message || response.statusText}`,
      "vercel_deployment",
      502
    );
  }

  return {
    id: data.id,
    url: data.url?.startsWith("http") ? data.url : `https://${data.url}`,
  };
}

async function sendReadyForReviewEmail(submission, result) {
  if (!process.env.RESEND_API_KEY) return;

  const html = `
    ${emailBaseStyles()}
    <h1>Website Ready for Review</h1>
    <p>The generated website preview for <strong>${escapeHtml(submission.businessName)}</strong> is ready.</p>

    <div class="section">
      <h2>Business</h2>
      <p><strong>${escapeHtml(submission.businessName)}</strong></p>
    </div>

    <div class="section">
      <h2>Client</h2>
      <p>${escapeHtml(submission.name)}<br>${escapeHtml(submission.email)}</p>
    </div>

    <div class="section">
      <h2>Preview Links</h2>
      <p><strong>Preview URL:</strong> <a href="${escapeHtml(result.deploymentUrl)}">${escapeHtml(result.deploymentUrl)}</a></p>
      <p><strong>GitHub Repo:</strong> <a href="${escapeHtml(result.repoUrl)}">${escapeHtml(result.repoUrl)}</a></p>
      <p><strong>Project Name:</strong> ${escapeHtml(result.projectName)}</p>
    </div>

    ${colorBlock(submission)}

    <div class="section">
      <h2>Next Steps</h2>
      <ul>
        <li>Review the generated website</li>
        <li>Check copy, layout, colors, and mobile responsiveness</li>
        <li>Make manual edits before sending to the client</li>
      </ul>
    </div>
  `;

  await sendEmail({
    to: OWNER_EMAIL,
    subject: `Website Ready for Review: ${submission.businessName}`,
    html,
  });
}

async function sendErrorEmail(payload, stepFailed, errorMessage) {
  if (!process.env.RESEND_API_KEY) return;

  const businessName = payload?.businessName || "Unknown Business";

  const html = `
    ${emailBaseStyles()}
    <h1>Website Launcher Error</h1>
    <p>The website generator failed.</p>

    <div class="section">
      <h2>Issue</h2>
      <p><strong>Step failed:</strong> ${escapeHtml(stepFailed)}</p>
      <p><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>
    </div>

    <div class="section">
      <h2>Submission</h2>
      <p><strong>Business:</strong> ${escapeHtml(businessName)}</p>
      <p><strong>Client:</strong> ${escapeHtml(payload?.name || "Unknown")}</p>
      <p><strong>Email:</strong> ${escapeHtml(payload?.email || "Unknown")}</p>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    </div>
  `;

  await sendEmail({
    to: OWNER_EMAIL,
    subject: `Website Launcher Error: ${businessName}`,
    html,
  });
}

async function sendEmail({ to, subject, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject,
      html: wrapEmail(html),
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Resend email failed: ${data?.message || response.statusText}`);
  }
}

function wrapEmail(content) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#111827;">
    <div style="max-width:720px;margin:0 auto;padding:32px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:28px;">
        ${content}
      </div>
    </div>
  </body>
</html>`;
}

function emailBaseStyles() {
  return `<style>
    h1 { color:#0A0F1C; margin:0 0 16px; font-size:24px; }
    h2 { color:#0A0F1C; margin:0 0 10px; font-size:16px; }
    p, li { color:#374151; font-size:14px; line-height:1.6; }
    a { color:#1A73FF; }
    .section { border-top:1px solid #E5E7EB; padding-top:18px; margin-top:18px; }
    .swatch { display:inline-block; width:18px; height:18px; border-radius:5px; border:1px solid #d1d5db; vertical-align:middle; margin-right:8px; }
    pre { white-space:pre-wrap; background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; padding:12px; font-size:12px; color:#111827; }
  </style>`;
}

function colorBlock(submission) {
  return `
    <div class="section">
      <h2>Brand Colors</h2>
      <p><span class="swatch" style="background:${submission.primaryColor}"></span><strong>Primary:</strong> ${submission.primaryColor}</p>
      <p><span class="swatch" style="background:${submission.secondaryColor}"></span><strong>Secondary:</strong> ${submission.secondaryColor}</p>
      <p><span class="swatch" style="background:${submission.accentColor}"></span><strong>Accent:</strong> ${submission.accentColor}</p>
    </div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
