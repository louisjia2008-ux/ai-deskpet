// Loaded by Electron before Playwright and the development app entry. Specific
// cases may replace the stub with a scripted choice after their profile is ready.
const { dialog } = require('electron');
dialog.showMessageBox = async (...args) => ({ response: args.at(-1)?.cancelId ?? 0, checkboxChecked: false });
// Startup failures must remain observable through the test process, without
// showing an application-modal macOS alert on the user's desktop.
dialog.showErrorBox = () => {};
