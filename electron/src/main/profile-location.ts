import type { App } from 'electron';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ArtifactMode } from './artifact-mode';

const selector = '--deskpet-isolated-profile';
export const wechatWorkerSwitch = '--deskpet-wechat-worker';
export const isolatedApplicationName = 'DeskPet Electron Candidate';
let isolatedRoot: string | null = null;
export const isIsolatedProfile = (): boolean => isolatedRoot !== null;
const directories = { appData: 'app-data', userData: 'profile', sessionData: 'cache', crashDumps: 'crash-dumps', logs: 'logs' } as const;
type ApplicationPaths = Pick<App, 'getPath' | 'setPath' | 'setName' | 'setAppLogsPath' | 'isPackaged'>;
export interface LaunchPlan {
  artifactMode: ArtifactMode;
  operation: 'interactive' | 'inspection';
  root: string | null;
  runtimeName: string;
  userData: string;
  inspection: { profilePath: string; reportPath: string } | null;
}

const option = (argv: readonly string[], name: string): string | undefined => {
  const values = argv.filter((arg) => arg === name || arg.startsWith(`${name}=`));
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !values[0]?.startsWith(`${name}=`) || values[0].length === name.length + 1) throw new Error('startup.argumentsConflict');
  return values[0].slice(name.length + 1);
};
const existingDirectory = (path: string): string => {
  if (!isAbsolute(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('An isolated profile requires an absolute, unlinked directory.');
  return realpathSync(path);
};
const validateChildren = (root: string): void => {
  for (const name of Object.values(directories)) {
    const path = join(root, name);
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Isolated application directories cannot be linked.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
};
const validateRoot = (requested: string, inspectionRuntime = false): string => {
  const root = existingDirectory(requested);
  const marker = join(root, inspectionRuntime ? 'inspection-runtime.json' : 'isolated-candidate.json');
  const info = lstatSync(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('An isolated profile marker cannot be linked or invalid.');
  const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
  const purpose = inspectionRuntime ? 'deskpet-profile-inspection' : 'deskpet-isolated-candidate';
  if (value === null || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('purpose' in value) || value.purpose !== purpose) throw new Error('The isolated candidate marker is invalid.');
  validateChildren(root);
  return root;
};
const rejectDailyContainer = (root: string, defaultAppData: string): void => {
  const daily = join(existsSync(defaultAppData) ? realpathSync(defaultAppData) : resolve(defaultAppData), 'DeskPet Electron');
  if (root === sep || root === daily || daily.startsWith(`${root}${sep}`) || root.startsWith(`${daily}${sep}`)) throw new Error('An isolated profile cannot overlap the daily profile.');
};

/** Kept for existing development callers; packaged candidate policy is in planProfileLocation. */
export const selectIsolatedProfile = (argv: readonly string[], defaultAppData: string): string | null => {
  const requested = option(argv, selector);
  if (requested === undefined) return null;
  const root = validateRoot(requested);
  rejectDailyContainer(root, defaultAppData);
  return root;
};

/** Resolve every option and existing path before applying paths or initializing anything. */
export const planProfileLocation = (application: ApplicationPaths, argv: readonly string[], artifactMode: ArtifactMode): LaunchPlan => {
  const known = [selector, wechatWorkerSwitch, '--deskpet-maintenance-root', '--deskpet-inspect-profile', '--deskpet-inspection-report'];
  if (argv.some((arg) => arg.startsWith('--deskpet-') && !known.some((name) => arg === name || arg.startsWith(`${name}=`)))) throw new Error('startup.argumentsConflict');
  if (argv.some((arg) => ['--user-data-dir', '--profile-directory'].some((name) => arg === name || arg.startsWith(`${name}=`)))) throw new Error('startup.argumentsConflict');
  const isolated = option(argv, selector);
  const maintenanceRoot = option(argv, '--deskpet-maintenance-root');
  const target = option(argv, '--deskpet-inspect-profile');
  const report = option(argv, '--deskpet-inspection-report');
  if (artifactMode === 'validation-candidate' && isolated === undefined) throw new Error('startup.candidateRequiresIsolation');
  if ((isolated !== undefined && maintenanceRoot !== undefined) || (artifactMode === 'validation-candidate' && maintenanceRoot !== undefined)) throw new Error('startup.argumentsConflict');
  const inspection = target !== undefined;
  const worker = argv.filter(arg => arg === wechatWorkerSwitch || arg.startsWith(wechatWorkerSwitch + '='));
  if (worker.length && (worker.length !== 1 || worker[0] !== wechatWorkerSwitch || isolated === undefined || inspection)) {
    throw new Error('startup.argumentsConflict');
  }
  if (inspection !== (report !== undefined) || (maintenanceRoot !== undefined && !inspection) || (inspection && isolated === undefined && maintenanceRoot === undefined)) throw new Error('startup.inspectionArgumentsInvalid');
  // Invalid candidate arguments/markers/children are rejected without even asking for daily appData.
  const root = isolated !== undefined ? validateRoot(isolated) : maintenanceRoot !== undefined ? validateRoot(maintenanceRoot, true) : null;
  let inspectionPlan: LaunchPlan['inspection'] = null;
  if (inspection) {
    const profilePath = existingDirectory(target);
    if (root !== null && (root === profilePath || root.startsWith(`${profilePath}${sep}`) || profilePath.startsWith(`${root}${sep}`))) throw new Error('startup.inspectionRuntimeOverlaps');
    if (!isAbsolute(report!) || existsSync(report!)) throw new Error('startup.inspectionReportInvalid');
    const reportPath = join(realpathSync(dirname(report!)), basename(report!));
    if (reportPath === profilePath || reportPath.startsWith(`${profilePath}${sep}`)) throw new Error('startup.inspectionReportInvalid');
    inspectionPlan = { profilePath, reportPath };
  }
  const defaultAppData = application.getPath('appData');
  if (root !== null) rejectDailyContainer(root, defaultAppData);
  const dailyProfile = join(resolve(defaultAppData), 'DeskPet Electron');
  if (inspectionPlan !== null && (inspectionPlan.profilePath === dailyProfile || inspectionPlan.profilePath.startsWith(`${dailyProfile}${sep}`))) throw new Error('startup.inspectionRequiresCopy');
  const testData = !application.isPackaged ? process.env.DESKPET_E2E_USER_DATA : undefined;
  return { artifactMode, operation: inspection ? 'inspection' : 'interactive', root,
    runtimeName: isolated !== undefined ? isolatedApplicationName : 'DeskPet Electron',
    userData: root !== null ? join(root, 'profile') : testData !== undefined && isAbsolute(testData) ? testData : join(defaultAppData, 'DeskPet Electron'),
    inspection: inspectionPlan };
};

export const applyProfileLocation = (application: ApplicationPaths, plan: LaunchPlan): void => {
  isolatedRoot = plan.root;
  application.setName(plan.runtimeName);
  if (plan.root !== null) {
    validateChildren(plan.root);
    for (const [key, name] of Object.entries(directories)) {
      const directory = join(plan.root, name);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (key === 'logs') application.setAppLogsPath(directory);
      else application.setPath(key as 'appData' | 'userData' | 'sessionData' | 'crashDumps', directory);
    }
  } else application.setPath('userData', plan.userData);
};

/** Existing normal/development behavior remains the default only for daily artifacts. */
export const configureProfileLocation = (application: ApplicationPaths, argv: readonly string[], artifactMode: ArtifactMode = 'daily'): LaunchPlan => {
  const plan = planProfileLocation(application, argv, artifactMode);
  applyProfileLocation(application, plan);
  return plan;
};
