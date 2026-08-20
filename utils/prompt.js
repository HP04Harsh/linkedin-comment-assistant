/**
 * utils/prompt.js
 * Builds system/user prompts for comment generation and normalizes
 * the model's raw output.
 */
import { profileToPrompt } from './profile.js';

/** Persona -> behavior instruction used inside the prompt. */
export const PERSONA_GUIDES = Object.freeze({
  Professional:
    'Write like a seasoned professional reacting thoughtfully. Use clear, confident language. Share a relevant insight or observation.',
  Technical:
    'Write like an engineer or expert reacting with depth. Reference technical details, patterns, or tradeoffs. Be specific.',
  Networking:
    'Write like you are building a genuine connection. Be warm, personable, and add a useful perspective.',
  'Job Seeker':
    'Write like someone interested in the space. Show enthusiasm without desperation. Highlight relevant interest.',
  General:
    'Write like a real person on LinkedIn. Be genuine and specific.',
});

/**
 * Minimal system prompt — short enough for small models to actually follow.
 * All the "never do X" rules that bloated the old prompt have been removed;
 * instead we focus on the positive behavior we want.
 */
export function buildSystemPrompt() {
  return [
    'Write LinkedIn comments like a real person. Be specific to the post. No generic praise.',
    'Output ONLY the comment text. No labels, no quotes, no explanation.',
  ].join('\n');
}

/**
 * Build a short, focused user prompt. Small models follow simple instructions
 * much better than long, complex ones. Keep it under ~10 clear directives.
 */
export function buildUserPrompt(postData, settings, options = {}) {
  const persona = PERSONA_GUIDES[settings.persona] || PERSONA_GUIDES.General;
  const target = Math.max(100, Math.min(500, Number(settings.length) || 200));

  const lines = [
    `Write a LinkedIn comment for this post. ${persona}`,
    `Length: ~${target} characters. One comment only, no labels or quotes.`,
  ];

  if (settings.mentionAuthor && postData.authorName) {
    lines.push(`Address the author "${postData.authorName}" by first name.`);
  } else {
    lines.push('Do NOT use the author's name.');
  }

  lines.push(
    'Start with your own thought — never open with "Great post" or similar.',
    'Reference one specific detail from the post.',
    'Do not summarize the post. Do not ask questions.',
  );

  // History / regenerate
  const history = options.history && options.history.length
    ? options.history
    : (options.previousComment ? [options.previousComment] : []);
  if (history.length) {
    const seen = history.slice(-5);
    lines.push(
      `Already wrote ${history.length} comment${history.length > 1 ? 's' : ''} — write something different:`,
      ...seen.map((c, i) => `  ${i + 1}. "${c}"`),
    );
  } else if (options.regenerate) {
    lines.push('Write something completely different from before.');
  }

  if (options.retryNote) {
    lines.push(options.retryNote);
  }

  // Post content
  if (postData.postText) {
    lines.push('', `Post:\n${postData.postText}`);
  } else {
    lines.push('', 'Media post (no text). Use hashtags to reference the topic.');
  }

  lines.push('', `Author: ${postData.authorName || '[Unknown]'}`);

  if (postData.hashtags && postData.hashtags.length) {
    lines.push(`Hashtags: ${postData.hashtags.join(' ')}`);
  }

  return lines.join('\n');
}

/** Compose the full { system, user } prompt pair. */
export function buildPrompt(postData, settings, options = {}) {
  return {
    system: buildSystemPrompt(),
    user: buildUserPrompt(postData, settings, options),
  };
}

/**
 * Phrases that mark model meta-commentary leaking into the output instead of
 * the comment itself (hedging, framing, offering alternatives).
 */
export const META_PHRASE_RE =
  /(?:post (?:content|text)|the (?:post|actual) (?:content|text)).{0,25}(?:wasn'?t|was not|unavailable|missing|not provided|provided)|as an ai|as a language model|i (?:don'?t|do not|can'?t|cannot|am unable|wasn'?t able) (?:have access|access|see|read|extract|know|get|have|reference)|i'?m (?:really |very )?(?:sorry|unable|afraid)|i am (?:really |very )?(?:sorry|unable|afraid)|unable to (?:assist|help|provide)|i (?:can'?t|cannot) (?:assist|help)|without the actual post (?:content|text)|here'?s (?:a|my|one) (?:comment|framework|draft|version|option|response|take|candidate|alternative|suggestion)|here is (?:a|my|one) (?:comment|framework|draft|version|option|response|take|candidate|alternative|suggestion)|under these parameters|general framework|candidate comment|framework for a|option [a-d1-4]|which comment|i'?ll (?:craft|create|write|draft)|i will (?:craft|create|write|draft)|based solely on the author|based on the author and|to reference|since i (?:don'?t|do not|have no|wasn'?t)|since we (?:don'?t|do not|have no)|i (?:don'?t|do not) have (?:any|the|access to)|given that the|because the post|since the post|i couldn'?t|couldn'?t extract|i don'?t know what|the post (?:talks?|discusses?|explores?|highlights?|focuses on|is about|delves)|this post (?:talks?|discusses?|is about|highlights?|focuses on|explores?)|the (?:comment|post) (?:should|will|would)|a good comment (?:should|would)|here'?s (?:a|my|one) comment|this comment (?:is|should|will)|let me (?:share|write|craft|draft|comment)|let'?s (?:write|craft|draft|comment)|i (?:would|could|will) (?:say|write|comment|respond)|i'?d comment|post description|the perfect comment|my comment (?:would|should|will)|based on this post|the author (?:highlights?|shares?|notes?|explains?|argues?|mentions?|writes?|talks about|points out)\b|in this post\b|this post (?:by|from)\b|^[A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)* (?:highlights?|shares?|notes?|explains?|argues?|mentions?|writes?|says?|talks about|points out)\b/i;

/** True if the text still contains model meta-commentary after cleanup. */
export function isMetaCommentary(text) {
  return META_PHRASE_RE.test(String(text || '')) || PLACEHOLDER_RE.test(String(text || ''));
}

/**
 * Literal template placeholders the model sometimes leaves unfilled, e.g.
 * "[topic based on hashtags]", "[Author's name]", "[specific insight]".
 */
export const PLACEHOLDER_RE =
  /\[[^\]]{0,60}(?:topic|hashtag|author|name|specific|insight|detail|point|field|industry|thing|mention|example|etc\.?|e\.g\.|based on)[^\]]*\]/i;

/** Strip code fences, stray quotes, labels, meta lines and extra whitespace. */
export function normalizeComment(text) {
  let out = String(text || '').trim();
  out = out.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  out = out.replace(/^['"`]+|['"`]+$/g, '').trim();
  out = out.replace(/^Comment:\s*/i, '').trim();

  // Model preamble ending in a colon before a quoted comment, e.g.
  //   ...approach: "Great insights here!"
  // Keep only the quoted comment itself.
  const quoted = out.match(/:\s*["\u201c'`]([\s\S]*?)["\u201d'`]\s*$/);
  if (quoted && quoted[1].trim()) out = quoted[1].trim();

  // Drop any line that is model meta-commentary (preamble, framing, options).
  out = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !META_PHRASE_RE.test(line))
    .join('\n');
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * If the model overshoots the limit, cut at the last sentence boundary
 * inside the allowed length instead of slicing mid-word.
 */
export function fitToLength(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSentence = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  if (lastSentence > max * 0.5) return cut.slice(0, lastSentence + 1).trim();
  const lastComma = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(';'));
  if (lastComma > max * 0.4) return cut.slice(0, lastComma + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.3) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

/**
 * True if the comment OPENS by addressing a specific person who is NOT the
 * post author. Catches the wrong-post failure where the model was given
 * another post's data and greets that other person by name.
 *
 * Only unambiguous patterns are flagged so common openers like "Thanks," or
 * "Great post," are never rejected:
 *  - "Hi/Hello/Hey <Name>,"
 *  - "<First> <Last>,"
 * A bare "<Name>," opener is left alone (too often a word, not a name).
 */
export function addressesWrongPerson(text, authorName) {
  const s = String(text || '').trim();
  if (!s || !authorName) return false;
  const authorWords = String(authorName).split(/\s+/).filter(Boolean);
  if (!authorWords.length) return false;
  const authorFirst = authorWords[0].toLowerCase().replace(/[^a-z]/g, '');
  const authorLast = authorWords[authorWords.length - 1].toLowerCase().replace(/[^a-z]/g, '');

  const salutation = s.match(/^(?:hi|hello|hey)\s+([A-Z][a-zA-Z.'-]+)\s*[,:]/i);
  if (salutation) {
    const n = salutation[1].toLowerCase().replace(/[^a-z]/g, '');
    return n !== authorFirst && n !== authorLast;
  }

  const fullName = s.match(/^((?:hi|hello|hey)\s+)?([A-Z][a-zA-Z.'-]+)\s+([A-Z][a-zA-Z.'-]+)\s*[,:]/);
  if (fullName) {
    const first = fullName[2].toLowerCase().replace(/[^a-z]/g, '');
    const last = fullName[3].toLowerCase().replace(/[^a-z]/g, '');
    const ok = first === authorFirst || first === authorLast || last === authorFirst || last === authorLast;
    return !ok;
  }

  return false;
}

/**
 * User-side prompt for filling a single job-application field the resume does
 * not cover (e.g. "Tell us about yourself", "Why do you want to work here").
 * field: { label, type, maxLength }, profile: structured resume profile.
 */
export function buildFieldPrompt(field, profile, job) {
  const f = field || {};
  const label = (f.label || 'this field').trim();
  const maxLen = Math.max(20, Number(f.maxLength) || 200);
  const profileText = profileToPrompt(profile);
  const jobText = job
    ? `Job: ${job.title || 'unknown role'}${job.company ? ` at ${job.company}` : ''}${job.description ? `. Description: ${job.description.slice(0, 400)}` : ''}`
    : '';
  const options = Array.isArray(f.options)
    ? f.options.map((o) => String(o || '').trim()).filter(Boolean)
    : [];
  return [
    `Application field: ${label}${f.type && f.type !== 'text' ? ` (type: ${f.type})` : ''}`,
    ...(options.length
      ? [
          'Choose EXACTLY ONE of these options. Answer with the option text only:',
          ...options.map((o, i) => `  ${i + 1}. ${o}`),
        ]
      : []),
    `Answer in ${maxLen} characters or fewer.`,
    '',
    'About the applicant (from their resume):',
    profileText || 'No resume provided - answer based only on the job and keep it professional.',
    jobText || '',
    '',
    'Return ONLY the answer text. Do not wrap it in quotes, do not add labels, do not add explanations.',
  ].join('\n');
}

/**
 * Batch prompt: answer MANY application fields at once so the AI understands
 * them in context. fields: [{ label, type, maxLength, options }].
 */
export function buildFieldsPrompt(fields, profile, job) {
  const profileText = profileToPrompt(profile);
  const jobText = job
    ? `Job: ${job.title || 'unknown role'}${job.company ? ` at ${job.company}` : ''}${job.description ? `. Description: ${job.description.slice(0, 400)}` : ''}`
    : '';
  const lines = [
    'Fill these job-application fields with the best value for this applicant, based ONLY on their background and the job. Use your judgment to understand what each field is really asking and give the most helpful, honest answer.',
    '',
    'For EVERY field output EXACTLY one line in this format (keep the number and the field label):',
    '  1. Field Label: answer',
    '  2. Field Label: -',
    '',
    'Rules:',
    '- Base every answer only on the applicant background and the job; never invent facts such as phone numbers, emails, addresses, dates, or names that are not listed.',
    '- If a field is a choose-one dropdown/radio, pick the exact option text that fits best.',
    '- Keep each answer under its character limit.',
    '- If a field genuinely cannot be answered, output a dash (-) as its value.',
    '- No extra text, no headers, no explanations. Only the numbered lines.',
    '',
    'Fields:',
  ];
  fields.forEach((f, i) => {
    const label = String(f.label || `Field ${i + 1}`).trim();
    const type = f.type && f.type !== 'text' ? ` (${f.type})` : '';
    const max = f.maxLength ? `, max ${f.maxLength} chars` : '';
    let desc = `${i + 1}. ${label}${type}${max}`;
    const options = Array.isArray(f.options) ? f.options.map((o) => String(o || '').trim()).filter(Boolean) : [];
    if (options.length) desc += ` [options: ${options.join(' | ')}]`;
    lines.push(desc);
  });
  lines.push('', 'About the applicant (from their resume):');
  lines.push(profileText || '(no resume provided - only answer fields the job makes obvious)');
  if (jobText) lines.push('', jobText);
  return lines.join('\n');
}

/**
 * Parse the model's batch answer into a map of 1-based field number -> value.
 * Handles "3. Years of experience: 5", "3. Years of experience = 5", and a
 * colon-less fallback "3. 5" when the label was omitted.
 */
export function parseFieldsAnswer(text, fields) {
  const answers = {};
  if (!text) return answers;
  const list = Array.isArray(fields) ? fields : [];
  const count = list.length;
  const labels = new Set(list.map((f) => String(f.label || '').trim().toLowerCase()));
  const lines = String(text).split(/\r?\n/);
  const accept = (idx, value) => {
    if (idx < 1 || idx > count) return;
    value = String(value || '').replace(/\s+/g, ' ').trim();
    if (!value || value === '-') return;
    value = value.replace(/^["']+|["']+$/g, '').trim();
    if (value && value !== '-') answers[idx] = value;
  };
  for (const raw of lines) {
    const m = raw.match(/^\s*(\d+)[.).:\s]*([^:]*?)[:=]\s*(.*)$/);
    if (m) {
      accept(Number(m[1]), m[3]);
      continue;
    }
    const m2 = raw.match(/^\s*(\d+)[.).:]\s*(.+)$/);
    if (m2) {
      const idx = Number(m2[1]);
      const rest = String(m2[2] || '').trim();
      // Guard: "3. City" with no value would otherwise re-fill City with its
      // own label text; only accept the fallback when it is not a bare label.
      if (rest && !labels.has(rest.toLowerCase()) && rest.length >= 2) accept(idx, rest);
    }
  }
  return answers;
}

/** Shared system instructions for a referral / opportunity DM. */
export function buildDMSystemPrompt() {
  return [
    'You are an expert networking assistant helping a professional send a LinkedIn private message (DM) requesting a referral or opportunities.',
    'You write like a real person: warm, concise, specific, and modest - never salesy or pushy.',
    'You never fabricate facts about the recipient or the writer.',
    'You respond with ONLY the message text - a single message, no preamble, no quotes, no subject line.',
  ].join('\n');
}

/**
 * User-side prompt for a referral / opportunity DM.
 * person: { name, headline, company, companySlug }, profile: resume profile,
 * options: { jobMatches: [{ title }], jobsUrl, retryNote }.
 */
export function buildDMPrompt(person, options = {}) {
  const name = (person && person.name) || '';
  const headline = (person && person.headline) || '';
  const company = (person && person.company) || '';
  const jobsUrl = options.jobsUrl || '';
  const jobMatches = (options.jobMatches || []).slice(0, 6);

  const lines = [
    'Write a LinkedIn private message (DM) asking this person for a referral or for opportunities. It must sound like a real person wrote it - warm, specific, modest, and short. Never be salesy or pushy.',
    '',
    'Requirements:',
  ];
  if (name) lines.push(`- Open with "Hi ${name}," and then go straight into the message.`);
  lines.push('- Include ONE genuine, specific praise line tied to this person\'s work (their company, role, or likely work area). Avoid generic flattery like "impressive background" or "great profile".');
  lines.push('- Briefly introduce yourself: your name, current role, and 1-2 skills from your background that are most relevant here.');
  lines.push(`- Ask, politely and modestly, whether they could share or consider you for opportunities${company ? ` at ${company}` : ''} matching your background.`);
  if (jobsUrl) {
    lines.push(`- If it fits naturally, reference their company's openings page: ${jobsUrl}`);
  }
  lines.push('- Keep the whole message under ~300 characters - it is a quick, warm DM, not an email.');
  lines.push('- NEVER invent specific job titles, names, or facts about the recipient beyond what is listed below.');
  if (options.retryNote) lines.push(`- ${options.retryNote}`);

  if (jobMatches.length) {
    lines.push('', 'Open jobs at their company that match your background (you may reference these specifically):');
    for (const j of jobMatches) lines.push(`- ${j.title}`);
  }

  lines.push('', 'Recipient:');
  lines.push(`Name: ${name || '(unknown)'}`);
  if (headline) lines.push(`Headline: ${headline}`);
  if (company) lines.push(`Company: ${company}`);

  lines.push('', 'Your background (from your resume):');
  lines.push(profileToPrompt(options.profile) || '(no resume uploaded - introduce yourself generically without inventing details)');
  lines.push('', 'Output ONLY the message text - no preamble, no quotes, no subject, no explanations, no "Here is your message".');
  return lines.join('\n');
}
