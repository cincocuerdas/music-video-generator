/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'output',
  'storage',
  'logs',
  'ComfyUI',
  'client/node_modules',
  'client/dist',
]);

const IGNORED_FILES = new Set([
  '.env',
  '.env.backup',
  '.env.local',
]);

const ASSIGNMENT_CHECK_EXCLUDE = new Set([
  '.env.example',
  'scripts/dev-tools/test_config.js',
]);

const ALLOWED_PLACEHOLDER_VALUES = new Set([
  '',
  'change_me',
  'change_me_refresh',
  'change_me_pepper',
  'replace_me',
  'valid_test_gemini_key',
  'valid_test_replicate_token',
]);

const TARGET_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.py',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.toml',
  '.env',
  '.txt',
]);

const TOKEN_PATTERNS = [
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { name: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'openai_like_key', regex: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
];

const SENSITIVE_ENV_KEYS = [
  'GEMINI_API_KEY',
  'REPLICATE_API_TOKEN',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_REFRESH_TOKEN_PEPPER',
];

function isIgnoredDir(relativePath) {
  return Array.from(IGNORED_DIRS).some(
    (dir) => relativePath === dir || relativePath.startsWith(`${dir}/`),
  );
}

function shouldScanFile(relativePath) {
  if (!relativePath) return false;
  if (IGNORED_FILES.has(path.basename(relativePath))) return false;
  if (isIgnoredDir(relativePath)) return false;

  const ext = path.extname(relativePath);
  if (!ext) return false;
  return TARGET_EXTENSIONS.has(ext);
}

function walkFiles(dirPath, basePath, result = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (isIgnoredDir(relativePath)) {
        continue;
      }
      walkFiles(fullPath, basePath, result);
      continue;
    }
    if (shouldScanFile(relativePath)) {
      result.push({ fullPath, relativePath });
    }
  }
  return result;
}

function checkTokenPatterns(text, relativePath, findings) {
  for (const { name, regex } of TOKEN_PATTERNS) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      findings.push({
        file: relativePath,
        type: name,
        sample: match[0].slice(0, 12),
      });
    }
    regex.lastIndex = 0;
  }
}

function normalizeEnvValue(raw) {
  if (!raw) return '';
  const noInlineComment = raw.split('#')[0].trim();
  if (!noInlineComment) return '';
  const quoteMatch = noInlineComment.match(/^['"](.*)['"]$/);
  return (quoteMatch ? quoteMatch[1] : noInlineComment).trim();
}

function checkSensitiveAssignments(text, relativePath, findings) {
  if (ASSIGNMENT_CHECK_EXCLUDE.has(relativePath)) {
    return;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const key of SENSITIVE_ENV_KEYS) {
      const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+)$`).exec(line);
      if (!assignment) continue;

      const normalized = normalizeEnvValue(assignment[1]);
      if (!normalized) continue;
      const lowered = normalized.toLowerCase();

      if (ALLOWED_PLACEHOLDER_VALUES.has(lowered)) {
        continue;
      }

      findings.push({
        file: relativePath,
        type: `sensitive_assignment:${key}`,
        line: i + 1,
        sample: normalized.slice(0, 8),
      });
    }
  }
}

function main() {
  try {
    const files = walkFiles(ROOT_DIR, ROOT_DIR);
    const findings = [];

    for (const { fullPath, relativePath } of files) {
      const content = fs.readFileSync(fullPath, 'utf8');
      checkTokenPatterns(content, relativePath, findings);
      checkSensitiveAssignments(content, relativePath, findings);
    }

    console.log(`scanned_files=${files.length}`);

    if (findings.length > 0) {
      console.error(`findings_count=${findings.length}`);
      for (const finding of findings.slice(0, 20)) {
        console.error(
          `finding file=${finding.file} type=${finding.type} line=${finding.line || '-'} sample=${finding.sample || '-'}`,
        );
      }
      console.error('secret_hygiene_test_status=FAIL');
      process.exit(1);
      return;
    }

    console.log('secret_hygiene_test_status=PASS');
  } catch (error) {
    console.error('secret_hygiene_test_status=FAIL');
    console.error(`error=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
