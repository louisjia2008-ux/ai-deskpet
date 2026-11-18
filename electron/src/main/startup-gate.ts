import type { LaunchPlan } from './profile-location';

interface StartupBranches {
  configure(plan: LaunchPlan): void;
  interactive(plan: LaunchPlan): void;
  inspection(plan: LaunchPlan): void;
  refuse(code: string): void;
}
/** No product branch is loaded unless the entire immutable package/argument gate passes. */
export const dispatchStartup = (resolve: () => LaunchPlan, branches: StartupBranches): void => {
  try {
    const plan = resolve();
    branches.configure(plan);
    if (plan.operation === 'inspection') branches.inspection(plan);
    else branches.interactive(plan);
  } catch (error) {
    const code = error instanceof Error && /^startup\.[a-zA-Z]+$/u.test(error.message) ? error.message : 'startup.isolationInvalid';
    branches.refuse(code);
  }
};
