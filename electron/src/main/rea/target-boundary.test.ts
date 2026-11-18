import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReaTargetBoundary } from './target-boundary';

const unitRoot = '/private/tmp/deskpet/output/deskpet-electron-next-integration-20261029/rea/unit-fixtures';
const owned: string[] = [];
const setup = async () => {
  await mkdir(unitRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(unitRoot, 'boundary-')); owned.push(root);
  const source = join(root, 'selected'), session = join(root, 'session'); await mkdir(source, { mode: 0o700 }); await mkdir(session, { mode: 0o700 });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'synthetic-static-only', main: 'main.js' }));
  await writeFile(join(source, 'main.js'), "const {app}=require('electron'); app.whenReady();");
  return { root, source, session };
};
afterEach(async () => { await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const asar = (entry: Record<string, unknown>): Buffer => {
  const encoded = Buffer.from(JSON.stringify({ files: { 'main.js': { size: 1, offset: '0', ...entry } } }));
  const header = Buffer.alloc(8 + Math.ceil(encoded.length / 4) * 4); header.writeUInt32LE(header.length - 4, 0); header.writeUInt32LE(encoded.length, 4); encoded.copy(header, 8);
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(header.length, 4); return Buffer.concat([prefix, header, Buffer.from('x')]);
};

describe('explicit frozen target boundary', () => {
  it('copies only the declared JavaScript artifact scope, keeps originals unchanged and never executes code', async () => {
    const s = await setup(), sentinel = join(s.root, 'MUST_NOT_EXIST');
    await writeFile(join(s.source, 'main.js'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed');`);
    await writeFile(join(s.source, '.env'), 'SYNTHETIC_NOT_AN_ANALYSIS_FILE'); await mkdir(join(s.source, 'node_modules')); await writeFile(join(s.source, 'node_modules', 'unselected.js'), 'outside dependency scope');
    const original = await readFile(join(s.source, 'main.js')); const boundary = new ReaTargetBoundary(s.session); const b = await boundary.bind(s.source);
    expect(b.files).toBe(2); expect(b.excluded).toEqual(['.env', 'node_modules/']);
    expect(await readFile(join(b.snapshotPath, 'main.js'))).toEqual(original); expect(await readFile(join(s.source, 'main.js'))).toEqual(original);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await boundary.analyzeArguments(b.token)).toMatchObject({ input_path: b.snapshotPath, integrity_policy: 'fail', detail: 'summary', max_heap_mb: 256 });
  });
  it('rejects real links and forbidden scope lexically before a nonexistent source lookup', async () => {
    const s = await setup(), forbidden = join(s.root, 'never-read-original'); const boundary = new ReaTargetBoundary(s.session, { forbiddenRoots: [forbidden] });
    await expect(boundary.bind(forbidden)).rejects.toThrow('rea.targetOutOfScope');
    await symlink(join(s.root, 'outside.js'), join(s.source, 'linked.js')); await expect(boundary.bind(s.source)).rejects.toThrow('rea.linkedOrSpecialTarget');
    await expect(boundary.bind(s.root)).rejects.toThrow('rea.targetOutOfScope');
  });
  it('binds opaque target and analysis tokens to this session and exact target', async () => {
    const s = await setup(), boundary = new ReaTargetBoundary(s.session), a = await boundary.bind(s.source), b = await boundary.bind(s.source);
    const analysis = boundary.retainAnalysis(a.token, `ev_${'a'.repeat(64)}`);
    expect(boundary.inspectArguments(a.token, analysis)).toEqual({ source: { kind: 'retained-evidence', evidence_id: `ev_${'a'.repeat(64)}` }, view: { kind: 'summary' } });
    expect(() => boundary.inspectArguments(b.token, analysis)).toThrow('rea.analysisTokenInvalid');
    expect(() => boundary.retainAnalysis(a.token, '/outside/evidence.json')).toThrow('rea.analysisEvidenceInvalid');
    const otherSession = join(s.root, 'other-session'); await mkdir(otherSession, { mode: 0o700 }); const other = new ReaTargetBoundary(otherSession);
    expect(() => other.resolve(a.token)).toThrow('rea.targetTokenInvalid');
    expect(() => boundary.inspectArguments(a.token, analysis, 'modules', { limit: 65 })).toThrow('rea.viewOutOfScope');
    // The actual application facts schema differs from semantic graph kinds.
    const projected = boundary.inspectArguments(a.token, analysis, 'boundaries').view as { where: { kinds: string[] }; property_keys: string[] };
    expect(projected.where.kinds).not.toContain('child-process');
    expect(projected.property_keys).toContain('preload_path');
    expect(projected.property_keys).toContain('web_preferences');
    boundary.dispose(); expect(() => boundary.resolve(a.token)).toThrow('rea.targetTokenInvalid');
  });
  it('rejects modified snapshots instead of silently following the changed source or adopting new authority', async () => {
    const s = await setup(), boundary = new ReaTargetBoundary(s.session), b = await boundary.bind(s.source);
    await chmod(join(b.snapshotPath, 'main.js'), 0o600); await writeFile(join(b.snapshotPath, 'main.js'), 'changed');
    await expect(boundary.analyzeArguments(b.token)).rejects.toThrow('rea.snapshotChanged');
  });
  it('enforces byte, file and depth budgets without tool execution', async () => {
    const s = await setup(); await expect(new ReaTargetBoundary(s.session, { maxFileBytes: 4 }).bind(s.source)).rejects.toThrow('rea.targetTooLarge');
    await expect(new ReaTargetBoundary(s.session, { maxFiles: 1 }).bind(s.source)).rejects.toThrow();
    await mkdir(join(s.source, 'a', 'b'), { recursive: true }); await writeFile(join(s.source, 'a', 'b', 'deep.js'), 'x');
    await expect(new ReaTargetBoundary(s.session, { maxDepth: 1 }).bind(s.source)).rejects.toThrow('rea.targetTooDeep');
  });
  it('admits bounded regular ASAR bytes but rejects internal links and unpacked outside resources', async () => {
    const s = await setup(), archive = join(s.root, 'selected.asar'); await writeFile(archive, asar({}));
    const boundary = new ReaTargetBoundary(s.session), b = await boundary.bind(archive); expect(b.kind).toBe('asar'); expect(b.sourcePaths).toEqual(['main.js']);
    await writeFile(archive, asar({ link: '../outside' })); await expect(boundary.bind(archive)).rejects.toThrow('rea.asarExternalEntry');
    await writeFile(archive, asar({ unpacked: true })); await expect(boundary.bind(archive)).rejects.toThrow('rea.asarExternalEntry');
  });
});
