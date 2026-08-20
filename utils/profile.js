/**
 * utils/profile.js
 * Client-side resume parsing: turns resume TEXT into a structured profile
 * (name, contacts, skills, experience, education, ...). Everything runs in
 * the extension - the raw resume never leaves the machine except for the
 * profile summary we optionally send to the AI provider to fill fields the
 * resume does not cover.
 *
 * Pure module: no chrome.* or DOM dependencies, so it is also usable from
 * Node unit tests.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4})|\b\d{4}[-. ]\d{4}\b/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.|in\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

const SECTION_HEADERS = [
  /^summary$/i, /^professional summary$/i, /^profile$/i, /^objective$/i, /^about(?: me)?$/i,
  /^(?:professional |work |employment |career )?(?:experience|history)$/i,
  /^education$/i, /^academic(?: background| qualification)?$/i,
  /^(?:core |technical |professional |key )?(?:skills|competencies)(?: & (?:expertise|competencies))?$/i,
  /^skills(?: & (?:expertise|competencies))?$/i,
  /^projects?$/i, /^(?:personal )?projects$/i,
  /^(?:personal|self[\s-]+driven|independent|academic|open[\s-]+source|side|freelance) projects?$/i,
  /^certifications?$/i, /^licenses?(?: & certifications?)?$/i, /^certificates?$/i,
  /^languages?$/i,
  /^awards?(?: & honors)?$/i, /^honors?$/i,
];

const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const YEAR = '(?:19|20)\\d{2}';
const DATE_RANGE_RE = new RegExp(
  `(?:${MONTHS}\\.?\\s*)?${YEAR}\\s*(?:\\s*[\\-–—/]\\s*(?:present|current|now|${MONTHS}\\.?\\s*)?${YEAR}|\\s*[\\-–—/]\\s*(?:present|current|now))`,
  'i'
);

const MONTH_TO_NUM = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const BULLET_CHARS = /[•▪·●○◆→»\-–—]+/;

// Leading list glyphs (incl. U+25E6 "◦" that resume tools often use, and
// U+2023/U+2043 bullets). Used to decide whether a line continues an entry.
const BULLET_RE = /^[•▪·●○◆→»◦‣▪\u2023\u2043\u25cf\u25cb\u25c9\u25aa\u25b8\u25ba\u203a\u25c6\u25a0\u2013\u2014]/;

/** Role words that mark a line as a job title (vs a company/location line). */
const ROLE_RE = /\b(engineer|designer|manager|developer|lead|consultant|analyst|architect|scientist|founder|owner|director|specialist|administrator|associate|coordinator|programmer|researcher|instructor|recruiter|marketer|writer|strategist|accountant|nurse|teacher|intern|volunteer|artist|editor)\b/i;

/** Words that hint a line names a school or a company. */
const SCHOOL_RE = /(university|college|institute|school|academy|iit|nit|vit)/i;
const DEGREE_RE = /\b(?:B\.?S\.?|B\.?A\.?|M\.?S\.?|M\.?A\.?|M\.?B\.?A\.?|Ph\.?D\.?|B\.?Tech\.?|M\.?Tech\.?|B\.?E\.?|M\.?E\.?|Bachelor|Master|Graduate|Diploma|Degree)\b/i;
const COMPANY_HINT_RE = /(ltd|inc|corp|co\.|llc|technolog|solutions|services|group|systems|university|college|institute|pvt|gmbh|bank|studio|consulting)/i;

function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Title-case a letter-spaced ALL-CAPS name ("HARSH PARDHI" -> "Harsh Pardhi"). */
function prettifyName(n) {
  const t = String(n || '').trim();
  if (/^[A-Z][A-Z']+(\s+[A-Z][A-Z'.'-]*)+$/.test(t)) {
    return t.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return t;
}

function isSectionHeader(line) {
  if (!line) return false;
  const t = line.replace(/^[\d\-–—•▪·.]+[)\]]?\s*/, '').replace(/:$/, '').trim();
  if (!t || t.length > 40) return false;
  const norm = t.replace(/\s+/g, ' ').trim();
  return SECTION_HEADERS.some((re) => re.test(norm));
}

/** Split the resume into { header, body } sections based on known headers. */
function splitSections(text) {
  const out = [];
  let current = { header: null, body: [] };
  for (const line of lines(text)) {
    if (isSectionHeader(line)) {
      if (current.header || current.body.length) out.push(current);
      current = { header: line.replace(/^[\d\-–—•▪·.]+[)\]]?\s*/, '').replace(/:$/, '').trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.header || current.body.length) out.push(current);
  return out;
}

function sectionMatches(section, patterns) {
  const h = (section.header || '').toLowerCase();
  return patterns.some((p) => h.includes(p));
}

function splitSkills(linesArr) {
  const skills = [];
  for (const line of linesArr) {
    // Strip a leading category label ("Cloud Platforms : ...", "DevOps & IaC : ...").
    const cleaned = line.replace(/^[\w &()/.,\-–—]+\s*:\s*/, '').trim();
    for (const part of cleaned.split(/[•▪·●○,;|\-–—]+/)) {
      const s = part.trim().replace(/^[()]+|[()]+$/g, '').replace(/\.$/, '');
      if (s.length >= 1 && s.length <= 45) skills.push(s);
    }
  }
  const seen = new Set();
  return skills.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Parse "Jan 2020 - Present" style dates into { start, end } year numbers. */
function parseDateRange(str) {
  const found = String(str).match(DATE_RANGE_RE);
  if (!found) return null;
  const parts = found[0].split(/\s*[\-–—/]\s*/);
  const parseYear = (s) => {
    if (!s) return null;
    if (/present|current|now/i.test(s)) return 'present';
    const m = s.match(/(?:19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  };
  const start = parseYear(parts[0]);
  const end = parts[1] ? parseYear(parts[1]) : start;
  if (start == null) return null;
  return { start, end: end === 'present' ? 'present' : (end || start) };
}

const KNOWN_LOCATIONS = [
  'United States', 'USA', 'U.S.', 'U.S.A.', 'US', 'UK', 'U.K.', 'India', 'Canada', 'Germany',
  'Australia', 'UAE', 'Singapore', 'France', 'Netherlands', 'Spain', 'Sweden', 'Ireland',
  'London', 'New York', 'San Francisco', 'Seattle', 'Austin', 'Bengaluru', 'Mumbai',
  'Toronto', 'Berlin', 'Amsterdam', 'Sydney', 'Remote',
];

function isLocationToken(tok) {
  const t = (tok || '').trim();
  if (!t) return true;
  if (/^\d{4,6}$/.test(t)) return true;               // zip / postal code
  if (/^[A-Z]{2}$/.test(t)) return true;               // "CA" - state code
  if (/^[A-Z][\w .'-]+,?\s+[A-Z]{2}$/.test(t)) return true;  // "City, ST"
  if (/^[A-Z][\w .'-]+,\s+(United States|India|UK|Canada|Germany|Australia|UAE|Singapore|France|Netherlands|Spain|Sweden|Ireland)$/i.test(t)) return true;
  return KNOWN_LOCATIONS.includes(t);
}

function splitJobLine(line) {
  // "Title | Company | Location" - the classic ATS separator.
  const bar = line.replace(DATE_RANGE_RE, '').split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  if (bar.length >= 2) {
    return { title: bar[0], company: bar.slice(1).filter((tok) => !isLocationToken(tok)).join(', ') };
  }
  // "Title at Company" / "Title @ Company"
  const at = line.replace(DATE_RANGE_RE, '').split(/\s+(?:at|@)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (at.length >= 2) {
    return { title: at[0], company: at.slice(1).join(' ') };
  }
  // "Company — Title" only when the line begins with a company-like token;
  // otherwise an em-dash is part of the title ("Software Engineer — Cloud Ops").
  const withoutDates = line.replace(DATE_RANGE_RE, '').trim();
  const lead = withoutDates.match(/^([^|–—]+)[–—]\s*(.+)$/);
  if (lead) {
    const left = lead[1].trim();
    if (COMPANY_HINT_RE.test(left)) {
      return { title: lead[2].trim(), company: left };
    }
    return { title: withoutDates, company: '' };
  }
  const comma = withoutDates.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  return { title: comma[0] || line.trim(), company: comma.slice(1).filter((tok) => !isLocationToken(tok)).join(', ') };
}

/** A line that starts a NEW job/project entry (title-ish line).
 *  allowPipe additionally treats "Name | stack" lines (project titles) as
 *  entry starts. Experience must NOT use it: wrapped paragraph lines can
 *  contain em-dashes and would be misread as new titles. */
function isTitleLine(line, allowPipe) {
  // Title with an inline date ("Software Engineer ... July 2024 - Present").
  if (DATE_RANGE_RE.test(line)) return line.replace(DATE_RANGE_RE, '').trim().length >= 5;
  // Project-style "Name — stack | ..." line.
  if (allowPipe && /\s\|\s/.test(line)) return true;
  return ROLE_RE.test(line);
}

/** Split experience/project lines into entries (title line + company + bullets). */
function splitEntries(bodyLines, allowPipe) {
  const entries = [];
  let cur = [];
  for (const line of bodyLines) {
    const isBullet = BULLET_RE.test(line);
    if (!isBullet && isTitleLine(line, allowPipe) && cur.length) {
      entries.push(cur);
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) entries.push(cur);
  return entries;
}

/** Split education lines into entries, keyed on school-name lines. */
function splitEducation(bodyLines) {
  const entries = [];
  let cur = [];
  for (const line of bodyLines) {
    // A new entry starts when a school line appears after an entry that
    // already names a school (covers "school / degree" and "degree / school"
    // orderings and date-only separators alike).
    if (SCHOOL_RE.test(line) && cur.length && cur.some((l) => SCHOOL_RE.test(l))) {
      entries.push(cur);
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) entries.push(cur);
  return entries;
}

/** A line whose whole content is a date range ("Jan 2019 - Present"). */
function isDateOnlyLine(line) {
  return DATE_RANGE_RE.test(line) && line.replace(DATE_RANGE_RE, '').trim() === '';
}

/** Strip leading list glyphs and whitespace from a description line. */
function cleanBullet(line) {
  return String(line || '').replace(/^[\s\u25e6\u2022\u00b7\u25cf\u25cb\u25c9\u25aa\u25b8\u25ba\u203a\u25c6\u25a0•▪·●○◆→»◦‣▪\-–—\u2023\u2043]+/, '').trim();
}

const COMPANY_TOKEN_RE = /^(ltd|ltd\.|inc|inc\.|corp|corp\.|co|co\.|llc|technologies|technology|tech|solutions|services|systems|software|group|consulting|healthineers|digital|global|cloud|data|pvt|private|limited|enterprises|enterprise|infotech|international|industries|industry|ventures|capital|partners|holdings|partnership|llp)$/i;

/** Pull the company out of a "Company  City, Country" second header line. */
function companyFromLine(line) {
  const s = String(line || '').trim();
  const locRe = /^((?:[A-Z][\w.'-]*\s+){0,2}[A-Z][\w.'-]*,\s*(?:[A-Z]{2}|United States|India|USA|UK|UAE|Canada|Germany|Australia|Singapore|France|Netherlands|Spain|Sweden|Ireland))\s*$/;
  for (let i = 0; i <= s.length; i++) {
    if (i > 0 && !/[,]?\s+$/.test(s.slice(0, i))) continue;
    const m = s.slice(i).match(locRe);
    if (!m) continue;
    if (COMPANY_TOKEN_RE.test(m[1].split(/\s+/)[0].replace(/[.,']/g, ''))) continue;
    return s.slice(0, i).replace(/[,\s]+$/, '').trim();
  }
  const bareRe = /^((?:[A-Z]{2}|United States|India|USA|UK|UAE|Canada|Germany|Australia|Singapore|France|Netherlands|Spain|Sweden|Ireland))\s*$/;
  for (let i = 0; i <= s.length; i++) {
    if (i > 0 && !/[,]?\s+$/.test(s.slice(0, i))) continue;
    if (bareRe.test(s.slice(i))) return s.slice(0, i).replace(/[,\s]+$/, '').trim();
  }
  return s;
}

function isEducationLike(block) {
  const t = block.join(' ').toLowerCase();
  return /(university|college|institute|school|b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|m\.?b\.?a\.?|ph\.?d\.?|bachelor|master|graduate|diploma|b\.?tech|m\.?tech)/.test(t);
}

/** Extract a street-city-state country-ish location line from contact area. */
function guessLocation(headLines) {
  for (const l of headLines) {
    const t = l.replace(/[.:;]$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!t || t.length > 40 || t.length < 4) continue;
    if (EMAIL_RE.test(t) || LINKEDIN_RE.test(t) || /^[A-Za-z]+\.\s/.test(t)) continue;
    // "City, ST" / "City, Country" / "Country" - alpha + spaces + at most 3 commas
    if (/^[A-Za-z][A-Za-z\s.,'-]*$/.test(t) && (t.includes(',') || /(United States|India|UK|USA|Canada|Germany|Australia|UAE|Singapore|France|Netherlands|Spain|Sweden|Ireland|U\.K\.|U\.S\.)/i.test(t))) {
      return t;
    }
  }
  return '';
}

/** Turn a resume's raw text into a structured profile object. */
export function extractProfile(rawText) {
  const text = cleanText(rawText);
  if (!text) return emptyProfile();

  const allLines = lines(text);
  const email = (text.match(EMAIL_RE) || [null])[0];
  const phone = (text.match(PHONE_RE) || [null])[0];
  const linkedin = ((text.match(LINKEDIN_RE) || [])[0] || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const websites = text.match(URL_RE) || [];
  const website = websites.find((u) => !/linkedin\.com/i.test(u)) || '';

  // Name: first line that looks like a person name (2-4 words, short). Names
  // may be letterspaced ALL-CAPS in PDFs ("HARSH PARDHI").
  let name = '';
  let nameIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    const t = allLines[i].replace(/[|•▪·].*$/, '').trim();
    if (!t || t.length > 60 || EMAIL_RE.test(t) || LINKEDIN_RE.test(t)) continue;
    const words = t.split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z][A-Za-z'-]*$/.test(w)) && !isSectionHeader(t)) {
      name = prettifyName(t);
      nameIdx = i;
      break;
    }
  }

  // Headline: short line right after the name that reads like a role (drop a
  // trailing " · stack · ..." suffix, common on generated resumes).
  let headline = '';
  if (nameIdx >= 0) {
    for (let i = nameIdx + 1; i < Math.min(nameIdx + 4, allLines.length); i++) {
      const t = allLines[i];
      if (!t || t.length > 90) continue;
      if (EMAIL_RE.test(t) || LINKEDIN_RE.test(t) || isSectionHeader(t)) continue;
      const head = t.replace(/\s*[·•|]\s*[\s\S]*$/, '').trim();
      if (/^[A-Za-z][A-Za-z0-9\s,.'+&/()\-–]*$/.test(head) && /\b(engineer|developer|manager|designer|consultant|analyst|scientist|specialist|lead|director|architect|founder|owner|student|intern|researcher|instructor|recruiter|marketer|coordinator|administrator|associate|programmer|writer|strategist|accountant|nurse|teacher)\b/i.test(head)) {
        headline = head;
        break;
      }
    }
  }

  const location = guessLocation(allLines.slice(0, Math.max(6, nameIdx + 4)));

  const sections = splitSections(text);

  let summary = '';
  const skills = [];
  const experience = [];
  const education = [];
  const projects = [];
  const certifications = [];

  for (const sec of sections) {
    const h = (sec.header || '').toLowerCase();
    if (/summary|profile|objective|about/.test(h) && !/experience/.test(h)) {
      summary = sec.body.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    } else if (/skills|competenc/.test(h)) {
      skills.push(...splitSkills(sec.body));
    } else if (/experience|history|employment/.test(h)) {
      for (const b of splitEntries(sec.body)) {
        const first = b[0] || '';
        const dates = parseDateRange(first) || parseDateRange(b.join(' '));
        const parts = splitJobLine(first);
        let company = parts.company;
        let descStart = 1;
        // Real resumes often put the company on the second header line.
        if (!company && b[1] && COMPANY_HINT_RE.test(b[1])) {
          company = companyFromLine(b[1]);
          descStart = 2;
        }
        const descLines = b.slice(descStart).map(cleanBullet).filter((l) => l && !isDateOnlyLine(l));
        experience.push({
          title: parts.title,
          company,
          dates: dates ? `${dates.start} - ${dates.end === 'present' ? 'Present' : dates.end}` : '',
          description: descLines.join(' · ').slice(0, 800),
        });
      }
    } else if (/education|academic/.test(h)) {
      for (const b of splitEducation(sec.body)) {
        const t = b.join(' ');
        const years = (t.match(DATE_RANGE_RE) || t.match(/\b(?:19|20)\d{2}\b/) || [null])[0] || '';
        const school = b.find((l) => /(university|college|institute|school|academy|iit)/i.test(l)) || b[0] || '';
        const degree = b.find((l) => DEGREE_RE.test(l)) || '';
        education.push({ school, degree, years, description: t.slice(0, 400) });
      }
    } else if (/project/.test(h)) {
      for (const b of splitEntries(sec.body, true)) {
        const title = (b[0] || '').split('|')[0].replace(DATE_RANGE_RE, '').replace(/[–—]\s*$/, '').trim();
        const descLines = b.slice(1).map(cleanBullet).filter((l) => l && !isDateOnlyLine(l));
        projects.push({ title, description: descLines.join(' · ').slice(0, 600) });
      }
    } else if (/certif|licen/.test(h)) {
      for (const l of sec.body) certifications.push(l.replace(/^[\d\-–—•▪·.]+/, '').trim());
    }
  }

  const profile = {
    name,
    headline,
    email,
    phone,
    location,
    linkedin,
    website,
    skills: skills.slice(0, 50),
    experience: experience.slice(0, 20),
    education: education.slice(0, 10),
    projects: projects.slice(0, 10),
    certifications: certifications.slice(0, 20),
    summary,
    sourceText: text,
    parsedAt: new Date().toISOString(),
  };
  return profile;
}

export function emptyProfile() {
  return {
    name: '', headline: '', email: '', phone: '', location: '', linkedin: '', website: '',
    skills: [], experience: [], education: [], projects: [], certifications: [], summary: '',
    sourceText: '', parsedAt: '',
  };
}

/** Rough total years of experience derived from experience date ranges. */
export function yearsOfExperience(profile) {
  const years = [];
  for (const e of profile.experience || []) {
    const m = String(e.dates || '').match(/(?:19|20)\d{2}\s*-\s*((?:19|20)\d{2}|present)/i);
    if (!m) continue;
    years.push({ start: Number(String(e.dates).match(/(?:19|20)\d{2}/)[0]), end: /present/i.test(m[1]) ? new Date().getFullYear() : Number(m[1]) });
  }
  if (!years.length) return null;
  const min = Math.min(...years.map((y) => y.start));
  const max = Math.max(...years.map((y) => y.end));
  return Math.max(0, max - min);
}

/**
 * A compact, redacted description of the profile used only to let the AI
 * answer application fields the resume does not cover (skills, essays, ...).
 */
export function profileToPrompt(profile) {
  const p = profile || {};
  const parts = [];
  if (p.name) parts.push(`Name: ${p.name}`);
  if (p.headline) parts.push(`Current role: ${p.headline}`);
  if (p.location) parts.push(`Location: ${p.location}`);
  if (p.skills && p.skills.length) parts.push(`Skills: ${p.skills.slice(0, 25).join(', ')}`);
  if (p.experience && p.experience.length) {
    parts.push('Experience:');
    p.experience.slice(0, 8).forEach((e) => {
      parts.push(`- ${e.title || ''}${e.company ? ` at ${e.company}` : ''}${e.dates ? ` (${e.dates})` : ''}`);
    });
  }
  if (p.education && p.education.length) {
    parts.push('Education:');
    p.education.slice(0, 5).forEach((e) => {
      parts.push(`- ${[e.degree, e.school, e.years].filter(Boolean).join(', ')}`);
    });
  }
  if (p.summary) parts.push(`Summary: ${p.summary.slice(0, 500)}`);
  return parts.join('\n');
}

/** True if the profile carries any usable resume content. */
export function isUsable(profile) {
  const p = profile || {};
  return !!(
    p.name || p.email || p.phone || p.location || p.linkedin ||
    (p.skills && p.skills.length) ||
    (p.experience && p.experience.length) ||
    (p.education && p.education.length) ||
    p.summary
  );
}
