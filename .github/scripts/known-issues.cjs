// Rebuilds the "Reported by users" list in extension/docs/KNOWN_ISSUES.md from every
// issue labeled "bug". Rebuilding the whole list (instead of appending one row) keeps
// it correct when several reports arrive at once and a queued run is skipped.
// Issue titles and bodies are untrusted: only an allowlisted title and a version
// number are copied, never other report text.

const FILE = 'extension/docs/KNOWN_ISSUES.md';
const START = '<!-- reported-issues:start -->';
const END = '<!-- reported-issues:end -->';
const EMPTY = '_No reports yet._';

function cleanTitle(title) {
  const text = String(title || '')
    .replace(/^\s*\[extension\]\s*/i, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/[^A-Za-z0-9 .,:;()'/+&#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const short = text.length > 100 ? `${text.slice(0, 97).trimEnd()}...` : text;
  return short || 'Untitled report';
}

function reportedVersion(body) {
  const match = /Handshook\s+v?(\d+\.\d+\.\d+)/i.exec(String(body || ''));
  return match ? match[1] : 'version not given';
}

function entry(issue) {
  const date = String(issue.created_at).slice(0, 10);
  const status = issue.state === 'closed' ? 'Closed' : 'Open';
  const version = reportedVersion(issue.body);
  const label = /^\d/.test(version) ? `Handshook ${version}` : version;
  return `- [#${issue.number}](${issue.html_url}): ${cleanTitle(issue.title)} (${label}, reported ${date}). **${status}**`;
}

function renderSection(issues) {
  const lines = issues
    .filter((issue) => !issue.pull_request)
    .sort((a, b) => b.number - a.number)
    .map(entry);
  return lines.length > 0 ? lines.join('\n') : EMPTY;
}

function updateDocument(doc, issues) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${FILE} is missing the ${START} / ${END} markers.`);
  }
  return `${doc.slice(0, start + START.length)}\n\n${renderSection(issues)}\n\n${doc.slice(end)}`;
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    labels: 'bug',
    state: 'all',
    per_page: 100,
  });
  const { data: file } = await github.rest.repos.getContent({ owner, repo, path: FILE });
  const current = Buffer.from(file.content, 'base64').toString('utf8');
  const next = updateDocument(current, issues);
  if (next === current) {
    core.info('Known issues list is already up to date.');
    return;
  }
  const trigger = context.payload.issue ? ` (#${context.payload.issue.number})` : '';
  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: FILE,
    sha: file.sha,
    message: `docs: update user-reported issues in KNOWN_ISSUES.md${trigger}`,
    content: Buffer.from(next, 'utf8').toString('base64'),
  });
  core.info('Known issues list updated.');
}

module.exports = { run, updateDocument, renderSection, cleanTitle, reportedVersion };
