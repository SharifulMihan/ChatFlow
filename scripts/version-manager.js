import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const RUNTIME_INCLUDE = [
  'manifest.json',
  'CHANGELOG.md',
  '_locales',
  'background',
  'content',
  'icons',
  'lib',
  'sidepanel',
  'src'
];

const EXCLUDED_SEGMENT_NAMES = new Set([
  'scratch',
  'tests',
  'test',
  'fixtures',
  'node_modules',
  'docs',
  '.git',
  'scripts'
]);

export function isValidChromeVersion(version) {
  if (typeof version !== 'string') return false;
  const parts = version.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(p => /^\d+$/.test(p) && !(p.length > 1 && p.startsWith('0')) && Number(p) <= 65535);
}

export function bumpVersionString(currentVersion, kind = 'patch') {
  if (!/^\d+\.\d+\.\d+$/.test(String(currentVersion || ''))) {
    throw new Error(`Invalid semantic version for bump: "${currentVersion}". Expected X.Y.Z.`);
  }
  const [maj, min, pat] = currentVersion.split('.').map(Number);
  switch (kind) {
    case 'patch':
      return `${maj}.${min}.${pat + 1}`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'major':
      return `${maj + 1}.0.0`;
    default:
      throw new Error(`Unknown bump kind "${kind}". Use patch, minor, or major.`);
  }
}

function stripMarkdownFormatting(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseChangelogReleases(changelogText = '') {
  const lines = String(changelogText || '').split(/\r?\n/);
  const releases = [];
  let unreleased = null;
  let currentRelease = null;
  let currentSection = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?$/);
    if (headingMatch) {
      const tag = headingMatch[1].trim();
      const rest = (headingMatch[2] || '').trim();
      if (tag.toLowerCase() === 'unreleased') {
        unreleased = { tag: 'Unreleased', sections: [] };
        currentRelease = unreleased;
        currentSection = null;
        continue;
      }
      const dateMatch = rest.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
      const date = dateMatch ? dateMatch[1] : '';
      const title = dateMatch ? dateMatch[2].replace(/^[\s-]+/, '').trim() : rest;
      const entry = {
        version: tag,
        date,
        title,
        highlights: [],
        sections: []
      };
      releases.push(entry);
      currentRelease = entry;
      currentSection = null;
      continue;
    }

    if (!currentRelease) continue;

    const subMatch = line.match(/^###\s+(.+)$/);
    if (subMatch) {
      currentSection = {
        heading: subMatch[1].trim(),
        items: []
      };
      currentRelease.sections.push(currentSection);
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const cleaned = stripMarkdownFormatting(bulletMatch[1]);
      if (currentRelease !== unreleased && currentSection?.heading.toLowerCase() === 'highlights') {
        currentRelease.highlights.push(cleaned);
      }
      if (!currentSection) {
        currentSection = { heading: 'Changes', items: [] };
        currentRelease.sections.push(currentSection);
      }
      currentSection.items.push(cleaned);
    }
  }

  for (const rel of releases) {
    if (rel.highlights.length === 0) {
      const fallback = [];
      for (const sec of rel.sections) {
        for (const item of sec.items) {
          fallback.push(item);
          if (fallback.length >= 4) break;
        }
        if (fallback.length >= 4) break;
      }
      rel.highlights = fallback;
    }
  }

  return { unreleased, releases };
}

export function renderVersionModuleSource({ version, releaseDate = '', highlights = [], changelogSummary = [] }) {
  const safeVersion = String(version || '').trim();
  const safeTag = `v${safeVersion}`;
  const safeHighlights = (Array.isArray(highlights) ? highlights : []).slice(0, 5);
  const safeChangelog = (Array.isArray(changelogSummary) ? changelogSummary : []).slice(0, 8);

  return `// AUTO-GENERATED from manifest.json and CHANGELOG.md by scripts/version-manager.js
// Do not edit version numbers here by hand; update manifest.json or run npm run version:sync.

export const APP_VERSION = ${JSON.stringify(safeVersion)};
export const APP_VERSION_TAG = ${JSON.stringify(safeTag)};
export const APP_DISPLAY_VERSION = ${JSON.stringify(`ChatFlow ${safeTag}`)};
export const RELEASE_DATE = ${JSON.stringify(String(releaseDate || ''))};
export const RELEASE_HIGHLIGHTS = Object.freeze(${JSON.stringify(safeHighlights, null, 2)});
export const CHANGELOG_SUMMARY = Object.freeze(${JSON.stringify(safeChangelog, null, 2)});

/**
 * Resolve extension version at runtime via Chrome manifest when available,
 * falling back to the generated APP_VERSION constant in Node tests or contexts
 * without chrome.runtime.getManifest.
 * @returns {string}
 */
export function getExtensionVersion() {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
    const manifest = chrome.runtime.getManifest();
    if (manifest && typeof manifest.version === 'string' && manifest.version.trim()) {
      return manifest.version.trim();
    }
  }
  return APP_VERSION;
}
`;
}

export function generateVersionModule({ rootDir = DEFAULT_ROOT } = {}) {
  const manifestPath = path.join(rootDir, 'manifest.json');
  const pkgPath = path.join(rootDir, 'package.json');
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const outPath = path.join(rootDir, 'src', 'version.js');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = String(manifest.version || '').trim();
  if (!isValidChromeVersion(version)) {
    throw new Error(`Invalid manifest.json version "${version}"`);
  }

  if (manifest.version_name !== version) {
    manifest.version_name = version;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== version) {
      pkg.version = version;
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
  }

  const changelogText = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const { releases } = parseChangelogReleases(changelogText);
  const matchingRelease = releases.find(r => r.version === version) || releases[0] || {
    version,
    date: new Date().toISOString().slice(0, 10),
    highlights: [],
    sections: []
  };

  const changelogSummary = releases.map(r => ({
    version: r.version,
    date: r.date,
    title: r.title,
    highlights: r.highlights.slice(0, 5),
    sections: r.sections
      .filter(s => s.heading.toLowerCase() !== 'highlights')
      .map(s => ({
        heading: s.heading,
        items: s.items.slice(0, 12)
      }))
  }));

  const source = renderVersionModuleSource({
    version,
    releaseDate: matchingRelease.date || '',
    highlights: matchingRelease.highlights,
    changelogSummary
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, source, 'utf8');
  return { version, outPath, highlights: matchingRelease.highlights };
}

function collectRuntimeFiles(rootDir, relDir, out = []) {
  const full = path.join(rootDir, relDir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.posix.join(relDir.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || EXCLUDED_SEGMENT_NAMES.has(entry.name)) continue;
      collectRuntimeFiles(rootDir, rel, out);
    } else if (entry.isFile() && /\.(js|html)$/i.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function stripJsComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export function validateRepoVersions({ rootDir = DEFAULT_ROOT, fileOverrides = null } = {}) {
  const errors = [];
  const readText = (relPath) => {
    const norm = relPath.replace(/\\/g, '/');
    if (fileOverrides && Object.prototype.hasOwnProperty.call(fileOverrides, norm)) {
      return fileOverrides[norm];
    }
    const full = path.join(rootDir, relPath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, 'utf8');
  };

  let manifest = null;
  const manifestRaw = readText('manifest.json');
  if (!manifestRaw) {
    errors.push('manifest.json not found');
    return { ok: false, version: null, errors };
  }
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    errors.push(`manifest.json invalid JSON: ${err.message}`);
    return { ok: false, version: null, errors };
  }

  const version = String(manifest.version || '').trim();
  if (!isValidChromeVersion(version)) {
    errors.push(`manifest.json version "${version}" is not valid Chrome version format (1-4 dot-separated integers)`);
  }
  if (manifest.version_name && String(manifest.version_name).trim() !== version) {
    errors.push(`manifest.json version_name "${manifest.version_name}" does not match manifest.json version "${version}"`);
  }

  const pkgRaw = readText('package.json');
  if (!pkgRaw) {
    errors.push('package.json not found');
  } else {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg.version !== version) {
        errors.push(`package.json version "${pkg.version}" does not match manifest.json version "${version}"`);
      }
    } catch (err) {
      errors.push(`package.json invalid JSON: ${err.message}`);
    }
  }

  const verModRaw = readText('src/version.js');
  if (!verModRaw) {
    errors.push('src/version.js not found (run npm run version:sync)');
  } else {
    const match = verModRaw.match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!match) {
      errors.push('src/version.js missing APP_VERSION export');
    } else if (match[1] !== version) {
      errors.push(`src/version.js APP_VERSION "${match[1]}" does not match manifest.json version "${version}"`);
    }
  }

  const readmeRaw = readText('README.md');
  if (!readmeRaw) {
    errors.push('README.md not found');
  } else {
    const badgeMatch = readmeRaw.match(/img\.shields\.io\/badge\/version-([0-9]+(?:\.[0-9]+){1,3})-/i);
    if (!badgeMatch) {
      errors.push('README.md missing version badge (version-X.Y.Z)');
    } else if (badgeMatch[1] !== version) {
      errors.push(`README.md badge version "${badgeMatch[1]}" does not match manifest.json version "${version}"`);
    }
  }

  const changelogRaw = readText('CHANGELOG.md');
  if (!changelogRaw) {
    errors.push('CHANGELOG.md not found');
  } else {
    const { releases } = parseChangelogReleases(changelogRaw);
    const latest = releases[0];
    if (!latest) {
      errors.push('CHANGELOG.md contains no released version headings');
    } else if (latest.version !== version) {
      errors.push(`CHANGELOG.md latest released heading "${latest.version}" does not match manifest.json version "${version}"`);
    }
  }

  // Ensure no hard-coded ChatFlow version literals remain inside runtime source files
  const runtimeFiles = new Set([
    ...collectRuntimeFiles(rootDir, 'background'),
    ...collectRuntimeFiles(rootDir, 'content'),
    ...collectRuntimeFiles(rootDir, 'lib'),
    ...collectRuntimeFiles(rootDir, 'sidepanel')
  ]);
  if (fileOverrides) {
    for (const rel of Object.keys(fileOverrides)) {
      if (/^(?:background|content|lib|sidepanel)\/.*\.(?:js|html)$/i.test(rel) && !/\/vendor\//.test(rel)) {
        runtimeFiles.add(rel);
      }
    }
  }

  const knownStaleVersions = new Set(['2.4.0', '2.3.0', '2.2.2', '2.2.0', '1.0.0']);
  for (const rel of runtimeFiles) {
    const raw = readText(rel);
    if (raw == null) continue;
    const content = /\.js$/i.test(rel) ? stripJsComments(raw) : raw;
    const matches = content.matchAll(/(?:['"`]|\bv)(\d+\.\d+\.\d+)\b/g);
    for (const m of matches) {
      const foundVer = m[1];
      if (foundVer === version || knownStaleVersions.has(foundVer)) {
        errors.push(`Hard-coded version "${foundVer}" found in ${rel}; read dynamically from src/version.js or chrome.runtime.getManifest().version`);
        break;
      }
    }
  }

  return {
    ok: errors.length === 0,
    version,
    errors
  };
}

export function bumpRelease({ rootDir = DEFAULT_ROOT, kind = 'patch', dateStr = null } = {}) {
  const manifestPath = path.join(rootDir, 'manifest.json');
  const pkgPath = path.join(rootDir, 'package.json');
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const oldVersion = String(manifest.version || '').trim();
  const nextVersion = bumpVersionString(oldVersion, kind);

  manifest.version = nextVersion;
  manifest.version_name = nextVersion;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = nextVersion;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  const readmePath = path.join(rootDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const updatedReadme = readme.replace(
      /(img\.shields\.io\/badge\/version-)([0-9]+(?:\.[0-9]+){1,3})(-)/i,
      `$1${nextVersion}$3`
    );
    if (updatedReadme !== readme) {
      fs.writeFileSync(readmePath, updatedReadme, 'utf8');
    }
  }

  const releaseDate = dateStr || new Date().toISOString().slice(0, 10);
  if (fs.existsSync(changelogPath)) {
    const rawChangelog = fs.readFileSync(changelogPath, 'utf8');
    const unreleasedRx = /^## \[Unreleased\]\s*\r?\n([\s\S]*?)(?=^## \[|$)/m;
    const match = rawChangelog.match(unreleasedRx);
    const unreleasedBody = match ? match[1].trim() : '';
    const sectionBody = unreleasedBody || `### Changed\n- Release v${nextVersion}.`;
    const newSection = `## [Unreleased]\n\n## [${nextVersion}] - ${releaseDate}\n\n${sectionBody}\n\n`;
    const updatedChangelog = match
      ? rawChangelog.replace(unreleasedRx, newSection)
      : `${newSection}${rawChangelog}`;
    fs.writeFileSync(changelogPath, updatedChangelog, 'utf8');
  }

  generateVersionModule({ rootDir });
  const check = validateRepoVersions({ rootDir });
  if (!check.ok) {
    throw new Error(`Post-bump validation failed:\n${check.errors.join('\n')}`);
  }
  return { oldVersion, nextVersion, releaseDate };
}

// ─── Minimal Pure-Node ZIP Builder for Release Packaging ──────────────────────

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(data);
    const { dosTime, dosDate } = toDosTimeDate(mtime);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt16LE(dosTime, 10);
    localHdr.writeUInt16LE(dosDate, 12);
    localHdr.writeUInt32LE(sum, 14);
    localHdr.writeUInt32LE(payload.length, 18);
    localHdr.writeUInt32LE(data.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, payload);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(method, 10);
    centralHdr.writeUInt16LE(dosTime, 12);
    centralHdr.writeUInt16LE(dosDate, 14);
    centralHdr.writeUInt32LE(sum, 16);
    centralHdr.writeUInt32LE(payload.length, 20);
    centralHdr.writeUInt32LE(data.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + payload.length;
  }

  const centralDirSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function collectPackableFiles(rootDir, relPath, out = []) {
  const full = path.join(rootDir, relPath);
  if (!fs.existsSync(full)) return out;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (EXCLUDED_SEGMENT_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      collectPackableFiles(rootDir, path.posix.join(relPath.replace(/\\/g, '/'), entry.name), out);
    }
  } else if (stat.isFile()) {
    if (/\.map$/i.test(relPath)) return out;
    out.push({
      name: relPath.replace(/\\/g, '/'),
      data: fs.readFileSync(full),
      mtime: stat.mtime
    });
  }
  return out;
}

export function buildReleaseZip({ rootDir = DEFAULT_ROOT, outFile = null } = {}) {
  const check = validateRepoVersions({ rootDir });
  if (!check.ok) {
    throw new Error(`Cannot build zip while version check fails:\n${check.errors.join('\n')}`);
  }
  const zipName = outFile || path.join(rootDir, `chatflow-v${check.version}.zip`);
  const entries = [];
  for (const item of RUNTIME_INCLUDE) {
    collectPackableFiles(rootDir, item, entries);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const zipBuf = buildZipBuffer(entries);
  fs.writeFileSync(zipName, zipBuf);
  return {
    zipPath: zipName,
    version: check.version,
    fileCount: entries.length,
    bytes: zipBuf.length,
    files: entries.map(e => e.name)
  };
}

// ─── CLI Entrypoint ───────────────────────────────────────────────────────────

function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'check';

  if (cmd === 'sync') {
    const res = generateVersionModule();
    console.log(`Synced src/version.js to ChatFlow v${res.version} (${res.highlights.length} highlights).`);
    return;
  }

  if (cmd === 'check') {
    const res = validateRepoVersions();
    if (!res.ok) {
      console.error('Version consistency check FAILED:');
      for (const err of res.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    console.log(`Version check PASSED: ChatFlow v${res.version} consistent across manifest, package, version module, README, CHANGELOG, and runtime sources.`);
    return;
  }

  if (cmd === 'bump') {
    const kind = args[1] || 'patch';
    const res = bumpRelease({ kind });
    console.log(`Bumped ChatFlow ${res.oldVersion} -> ${res.nextVersion} (${res.releaseDate}).`);
    return;
  }

  if (cmd === 'zip') {
    const res = buildReleaseZip();
    console.log(`Built ${path.basename(res.zipPath)} (${res.fileCount} files, ${res.bytes.toLocaleString()} bytes).`);
    return;
  }

  console.error(`Unknown command: ${cmd}. Use check | sync | bump <patch|minor|major> | zip.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli();
}
