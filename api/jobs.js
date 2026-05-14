import { neon } from '@neondatabase/serverless';

const MCF_BASE = 'https://api.mycareersfuture.gov.sg/v2/jobs';
const SEARCHES = [
  'sustainability', 'environmental', 'ESG',
  'carbon climate', 'renewable energy', 'circular economy',
];

// ── Mapping helpers ──────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getSector(job) {
  const t = (job.title || '').toLowerCase();
  const d = (job.description || '').toLowerCase();
  const cat = job.categories?.[0]?.category || '';
  const isSustain =
    t.includes('sustainab') || t.includes('environ') || t.includes('green') ||
    t.includes('carbon') || t.includes('climate') || t.includes('esg') ||
    t.includes('renewab') || t.includes('circular') || t.includes('nature') ||
    t.includes('conservation') || t.includes('ecology') ||
    d.includes('sustainability') || d.includes('net zero') || d.includes('decarboni') ||
    cat === 'Environmental Services' || cat === 'Energy and Chemicals';
  if (isSustain) return 'Environmental Sustainability';
  const map = {
    'Banking and Finance': 'Finance', 'Financial Services': 'Finance',
    'Information and Communications': 'Tech', 'Technology': 'Tech',
    'Logistics and Supply Chain': 'Logistics', 'Media': 'Media',
    'E-Commerce': 'E-commerce', 'Retail': 'E-commerce',
  };
  return map[cat] || cat || 'Other';
}

function mapMCFJob(job) {
  const company = job.postedCompany?.name || 'Unknown';
  const words = company.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  const companyShort = words.length <= 2 ? words.join(' ') : words.map(w => w[0]).join('').toUpperCase();

  const sector = getSector(job);
  const skills = (job.skills || []).map(s => s.skill).filter(Boolean);
  const subAreas = skills.length ? skills.slice(0, 4) : [job.categories?.[0]?.category || 'General'];

  const desc = (job.description || '').toLowerCase();
  let workMode = 'On-site';
  if (desc.includes('fully remote') || desc.includes('work from home')) workMode = 'Remote';
  else if (desc.includes('hybrid')) workMode = 'Hybrid';

  let durationMonths = 6;
  const durMatch = desc.match(/(\d+)[- ]*(month|months)/i);
  if (durMatch) durationMonths = Math.min(parseInt(durMatch[1]), 12);

  const empCount = job.postedCompany?.employeeCount;
  let companySize = 'Mid (200-1000)';
  if (empCount != null) {
    if (empCount < 50)   companySize = 'Small (<50)';
    else if (empCount < 200)  companySize = 'Startup (50-200)';
    else if (empCount < 1000) companySize = 'Mid (200-1000)';
    else companySize = 'Large (1000+)';
  }

  const min = job.salary?.minimum, max = job.salary?.maximum;
  const isHidden = job.metadata?.isHideSalary;
  let stipend = 'Undisclosed';
  if (!isHidden && min && max) stipend = `S$${min.toLocaleString()} – ${max.toLocaleString()} / month`;
  else if (!isHidden && min)   stipend = `S$${min.toLocaleString()} / month`;
  else if (!isHidden && max)   stipend = `Up to S$${max.toLocaleString()} / month`;

  const postedDate = job.metadata?.newPostingDate || new Date().toISOString().slice(0, 10);
  const daysAgo = Math.floor((Date.now() - new Date(postedDate).getTime()) / 86400000);
  const posted = daysAgo === 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;

  const scope = stripHtml(job.description).slice(0, 400);
  const requirements = skills.slice(0, 6).map(s => s.charAt(0).toUpperCase() + s.slice(1));

  return {
    id: job.uuid,
    title: job.title,
    company,
    companyShort,
    sector,
    subAreas,
    location: job.address?.isOverseas ? 'Overseas' : 'Singapore',
    workMode,
    companySize,
    durationMonths,
    startMonth: 'Sep 2026',
    deadline: job.metadata?.expiryDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    mentorship: false,
    mentorTitle: null,
    sources: ['MyCareersFuture'],
    stipend,
    posted,
    scope: scope || 'See full listing on MyCareersFuture.',
    requirements: requirements.length ? requirements : ['See full listing'],
    mcfUrl: job.metadata?.jobDetailsUrl,
  };
}

async function fetchFromMCF() {
  const seen = new Set();
  const jobs = [];
  await Promise.allSettled(SEARCHES.map(async (q) => {
    const res = await fetch(`${MCF_BASE}?search=${encodeURIComponent(q)}&limit=30&sortBy=new_posting_date`);
    if (!res.ok) return;
    const data = await res.json();
    for (const j of (data.results || [])) {
      if (!seen.has(j.uuid)) { seen.add(j.uuid); jobs.push(mapMCFJob(j)); }
    }
  }));
  return jobs;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');

  const sql = neon(process.env.DATABASE_URL);

  // Ensure table exists
  await sql`
    CREATE TABLE IF NOT EXISTS jobs_cache (
      id          TEXT PRIMARY KEY,
      data        JSONB        NOT NULL,
      fetched_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `;

  // Return cached jobs if fresh (< 1 hour old)
  const freshCheck = await sql`
    SELECT COUNT(*) AS count FROM jobs_cache
    WHERE fetched_at > NOW() - INTERVAL '1 hour'
  `;
  if (parseInt(freshCheck[0].count) > 0) {
    const rows = await sql`SELECT data FROM jobs_cache ORDER BY data->>'deadline' ASC`;
    return res.status(200).json(rows.map(r => r.data));
  }

  // Fetch fresh from MCF
  let jobs = [];
  try {
    jobs = await fetchFromMCF();
  } catch {
    // MCF unreachable — return stale cache if any
    const rows = await sql`SELECT data FROM jobs_cache`;
    return res.status(200).json(rows.map(r => r.data));
  }

  // Persist to Neon
  if (jobs.length > 0) {
    await sql`TRUNCATE jobs_cache`;
    for (const job of jobs) {
      await sql`
        INSERT INTO jobs_cache (id, data, fetched_at)
        VALUES (${job.id}, ${JSON.stringify(job)}, NOW())
        ON CONFLICT (id) DO UPDATE
          SET data = EXCLUDED.data, fetched_at = NOW()
      `;
    }
  }

  res.status(200).json(jobs);
}
