// Imported code keeps its original style; unresolved names must still fail CI.
const waitCapable = new Set(['digOut', 'smelt', 'surface', 'unstick', 'runPlanned', 'runPlannerStep']);

function callsWaitCapable(node) {
  if (!node) return false;
  if (node.type === 'AwaitExpression' || node.type === 'ChainExpression') return callsWaitCapable(node.argument ?? node.expression);
  if (node.type === 'ConditionalExpression') return callsWaitCapable(node.consequent) || callsWaitCapable(node.alternate);
  if (node.type !== 'CallExpression') return false;
  const { callee } = node;
  return waitCapable.has(callee.type === 'MemberExpression' ? callee.property.name : callee.name);
}

const requireCompletionCheck = {
  meta: {
    schema: [],
    messages: { completion: 'Use isComplete(result) to distinguish completion from a wait.' },
  },
  create(context) {
    function checkAccess(node) {
      const property = node.computed ? node.property.value : node.property.name;
      if (property === 'ok') context.report({ node, messageId: 'completion' });
    }
    return {
      VariableDeclarator(node) {
        if (!callsWaitCapable(node.init)) return;
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          for (const { identifier } of variable.references) {
            const parent = identifier.parent;
            if (parent.type === 'MemberExpression' && parent.object === identifier) checkAccess(parent);
          }
        }
      },
      MemberExpression(node) {
        if (callsWaitCapable(node.object)) checkAccess(node);
      },
    };
  },
};

export default [{
  files: ['minecraft-runtime/vendor/server/**/*.js', 'minecraft-runtime/test/**/*.js', 'minecraft-runtime/test-support/**/*.cjs', 'minecraft-runtime/tools/**/*.cjs', 'minecraft-companion-runtime/*.js', 'minecraft-companion-runtime/core/**/*.js', 'minecraft-companion-runtime/test/*.js', 'minecraft-companion-runtime/tools/*.js'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: Object.fromEntries([
      'require', 'module', 'process', '__dirname', 'Buffer', 'console',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'AbortController', 'AbortSignal', 'URL', 'setImmediate', 'clearImmediate', 'performance', 'structuredClone',
    ].map((name) => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error' },
}, {
  files: ['minecraft-companion-runtime/core/**/*.js'],
  plugins: { 'core-results': { rules: { 'require-completion-check': requireCompletionCheck } } },
  rules: { 'core-results/require-completion-check': 'error' },
}];
