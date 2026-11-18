// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArtifactMode } from './artifact-mode';
import { planProfileLocation, applyProfileLocation } from './profile-location';
import { dispatchStartup } from './startup-gate';

const roots: string[] = [];
const fixture = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deskpet-entry-gate-'))); roots.push(root);
  writeFileSync(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  return root;
};
const application = () => ({ isPackaged: true, getPath: vi.fn(() => '/daily-app-data'), setPath: vi.fn(), setName: vi.fn(), setAppLogsPath: vi.fn() });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('immutable package gate before storage and automatic work', () => {
  it('requires an explicit signed package mode, ignoring runtime mode environment', () => {
    const root = fixture(); writeFileSync(join(root, 'package.json'), JSON.stringify({ deskpetBuild: { version: 1, mode: 'validation-candidate' } }));
    vi.stubEnv('DESKPET_PACKAGE_MODE', 'daily');
    expect(readArtifactMode(root, true)).toBe('validation-candidate');
    writeFileSync(join(root, 'package.json'), '{}'); expect(() => readArtifactMode(root, true)).toThrow('packageModeInvalid');
    expect(readArtifactMode(root, false)).toBe('daily');
    writeFileSync(join(root, 'package.json'), '{"deskpetBuild":{"version":1,"mode":"unknown"}}'); expect(() => readArtifactMode(root, true)).toThrow('packageModeInvalid');
    writeFileSync(join(root, 'package.json'), '{"deskpetBuild":{"version":1,"mode":["validation-candidate"]}}'); expect(() => readArtifactMode(root, true)).toThrow('packageModeInvalid');
  });
  it.each(['missing', 'duplicate', 'relative', 'marker', 'linked-child', 'chromium-conflict', 'runtime-downgrade'] as const)('refuses %s before applying paths or loading any operational branch', (kind) => {
    const root = fixture(); const app = application();
    let argv = [`--deskpet-isolated-profile=${root}`];
    if (kind === 'missing') argv = [];
    if (kind === 'duplicate') argv.push(argv[0]!);
    if (kind === 'relative') argv = ['--deskpet-isolated-profile=relative'];
    if (kind === 'marker') writeFileSync(join(root, 'isolated-candidate.json'), '{}');
    if (kind === 'linked-child') { const other = fixture(); symlinkSync(other, join(root, 'logs')); }
    if (kind === 'chromium-conflict') argv.push(`--user-data-dir=${root}`);
    if (kind === 'runtime-downgrade') argv.push('--deskpet-package-mode=daily');
    const before = readdirSync(root).sort();
    const branches = { configure: vi.fn((plan) => applyProfileLocation(app, plan)), interactive: vi.fn(), inspection: vi.fn(), refuse: vi.fn() };
    dispatchStartup(() => planProfileLocation(app, argv, 'validation-candidate'), branches);
    expect(branches.refuse).toHaveBeenCalledOnce();
    expect(branches.configure).not.toHaveBeenCalled(); expect(branches.interactive).not.toHaveBeenCalled(); expect(branches.inspection).not.toHaveBeenCalled();
    expect(app.getPath).not.toHaveBeenCalled(); expect(app.setName).not.toHaveBeenCalled(); expect(app.setPath).not.toHaveBeenCalled(); expect(app.setAppLogsPath).not.toHaveBeenCalled();
    expect(readdirSync(root).sort()).toEqual(before);
  });
  it('allows candidate interactive only after all paths are validated and applied', () => {
    const root = fixture(); const app = application(); const order: string[] = [];
    dispatchStartup(() => planProfileLocation(app, [`--deskpet-isolated-profile=${root}`], 'validation-candidate'), {
      configure: (plan) => { order.push('configure'); applyProfileLocation(app, plan); }, interactive: (plan) => { order.push('interactive'); expect(plan.runtimeName).toBe('DeskPet Electron Candidate'); },
      inspection: () => { throw Error('Wrong branch'); }, refuse: () => { throw Error('Unexpected refusal'); },
    });
    expect(order).toEqual(['configure', 'interactive']); expect(app.setPath).toHaveBeenCalledWith('userData', join(root, 'profile'));
  });
  it('routes read-only inspection without invoking the interactive lock/recovery/controller branch', () => {
    const root = fixture(); const target = fixture(); const report = join(root, 'report.json'); const app = application();
    const branches = { configure: vi.fn(), interactive: vi.fn(), inspection: vi.fn(), refuse: vi.fn() };
    dispatchStartup(() => planProfileLocation(app, [`--deskpet-isolated-profile=${root}`, `--deskpet-inspect-profile=${target}`, `--deskpet-inspection-report=${report}`], 'validation-candidate'), branches);
    expect(branches.configure).toHaveBeenCalledOnce(); expect(branches.inspection).toHaveBeenCalledOnce(); expect(branches.interactive).not.toHaveBeenCalled(); expect(branches.refuse).not.toHaveBeenCalled();
  });
  it('keeps daily defaults and permits a distinct diagnostic runtime retaining daily credential identity', () => {
    const app = application(); const normal = planProfileLocation(app, [], 'daily');
    expect(normal.userData).toBe('/daily-app-data/DeskPet Electron'); expect(normal.runtimeName).toBe('DeskPet Electron');
    const root = fixture(); const target = fixture(); writeFileSync(join(root, 'inspection-runtime.json'), JSON.stringify({ version: 1, purpose: 'deskpet-profile-inspection' }));
    const plan = planProfileLocation(app, [`--deskpet-maintenance-root=${root}`, `--deskpet-inspect-profile=${target}`, `--deskpet-inspection-report=${join(root, 'report.json')}`], 'daily');
    expect(plan.runtimeName).toBe('DeskPet Electron'); expect(plan.userData).toBe(join(root, 'profile')); expect(plan.operation).toBe('inspection');
  });
  it('rejects a report inside the inspected profile before any directory is created', () => {
    const root = fixture(); const target = fixture(); const before = readdirSync(root);
    expect(() => planProfileLocation(application(), [`--deskpet-isolated-profile=${root}`, `--deskpet-inspect-profile=${target}`, `--deskpet-inspection-report=${join(target, 'report.json')}`], 'validation-candidate')).toThrow('inspectionReportInvalid');
    expect(readdirSync(root)).toEqual(before);
  });
  it('rejects runtime/inspection overlap before writing native cache or profile directories', () => {
    const root = fixture(); const app = application();
    expect(() => planProfileLocation(app, [`--deskpet-isolated-profile=${root}`, `--deskpet-inspect-profile=${root}`, `--deskpet-inspection-report=${join(tmpdir(), 'not-created-report.json')}`], 'validation-candidate')).toThrow('inspectionRuntimeOverlaps');
    expect(app.getPath).not.toHaveBeenCalled(); expect(readdirSync(root)).toEqual(['isolated-candidate.json']);
  });
  it('keeps ordinary effects in a lazy module, outside the inspection/refusal bootstrap import graph', () => {
    const bootstrap = readFileSync(join(__dirname, 'bootstrap.ts'), 'utf8');
    expect(bootstrap).not.toMatch(/^import .*AppController/m); expect(bootstrap).not.toContain('requestSingleInstanceLock'); expect(bootstrap).not.toContain('applyPendingProfileRestore');
    expect(bootstrap).toContain("import('./interactive-startup')");
    const interactive = readFileSync(join(__dirname, 'interactive-startup.ts'), 'utf8'); expect(interactive).toContain('requestSingleInstanceLock'); expect(interactive).toContain('applyPendingProfileRestore');
    const diagnostic = readFileSync(join(__dirname, 'profile-inspection.ts'), 'utf8'); expect(diagnostic).not.toContain('new DomainRepository'); expect(diagnostic).not.toContain('new AppController');
  });
});
