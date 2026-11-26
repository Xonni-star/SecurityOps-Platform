import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const browserGlobals={
  window:'readonly',document:'readonly',localStorage:'readonly',sessionStorage:'readonly',
  navigator:'readonly',location:'readonly',history:'readonly',fetch:'readonly',crypto:'readonly',
  alert:'readonly',confirm:'readonly',prompt:'readonly',setTimeout:'readonly',clearTimeout:'readonly',
  setInterval:'readonly',clearInterval:'readonly',requestAnimationFrame:'readonly',
  cancelAnimationFrame:'readonly',URL:'readonly',Blob:'readonly',File:'readonly',FormData:'readonly',
  AbortSignal:'readonly',Request:'readonly',Response:'readonly',HTMLElement:'readonly',
  HTMLInputElement:'readonly',Node:'readonly',Event:'readonly',MouseEvent:'readonly',WebSocket:'readonly',
};

const nodeGlobals={
  process:'readonly',console:'readonly',Buffer:'readonly',global:'readonly',__dirname:'readonly',module:'readonly',require:'readonly',
  setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',
  fetch:'readonly',URL:'readonly',AbortSignal:'readonly',TextEncoder:'readonly',TextDecoder:'readonly',
};

export default tseslint.config(
  {ignores:[
    '**/node_modules/**','**/dist/**','**/coverage/**','**/build/**','**/.restore-drill/**',
    '**/e2e-results/**','**/test-results/**','**/playwright-report/**','**/android/.gradle/**',
    '**/android/app/build/**','**/*.min.js',
  ]},
  js.configs.recommended,
  {rules:{'no-empty':['error',{allowEmptyCatch:true}]}},
  ...tseslint.configs.recommended,
  {
    files:['**/*.{ts,tsx}'],
    plugins:{'react-hooks':reactHooks},
    rules:{
      'no-undef':'off',
      'no-unused-vars':'off',
      '@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}],
      '@typescript-eslint/no-explicit-any':'off',
      '@typescript-eslint/no-empty-object-type':'off',
      '@typescript-eslint/no-namespace':'off',
      '@typescript-eslint/no-require-imports':'off',
      'react-hooks/rules-of-hooks':'error',
      'react-hooks/exhaustive-deps':'off',
    },
  },
  {
    files:['frontend/**/*.{ts,tsx}'],
    languageOptions:{globals:browserGlobals},
  },
  {
    files:['frontend/public/sw.js'],
    languageOptions:{globals:{...browserGlobals,self:'readonly',caches:'readonly',clients:'readonly'}},
  },
  {
    files:['backend/**/*.{ts,tsx}','**/*.{js,mjs,cjs}'],
    languageOptions:{globals:nodeGlobals},
  },
  {
    files:['tests/**/*.ts','e2e/**/*.ts','playwright.config.ts'],
    languageOptions:{globals:{...browserGlobals,...nodeGlobals,describe:'readonly',it:'readonly',expect:'readonly',beforeEach:'readonly',afterEach:'readonly',beforeAll:'readonly',afterAll:'readonly',jest:'readonly',vi:'readonly',test:'readonly'}},
  },
);
