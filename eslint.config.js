// ESLint 扁平配置。
//
// 这里主要管的不是代码风格（那个交给约定与编辑器），而是**分层约束**：
// 把「谁可以依赖谁」写成机器可检查的规则。架构意图一旦只写在文档里，
// 就会随提交次数慢慢衰减；写成 lint 规则则会当场拦下。
import { defineConfig } from 'eslint/config';

const BASE_RULES = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off', // 浏览器/Node 全局混用，靠运行时暴露；装 globals 包不值得
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'no-console': 'off', // CLI 工具，输出就是产品
};

export default defineConfig([
  {
    ignores: ['src/web/public/**', 'node_modules/**', '.tool/**', '.claude/**', 'assets/**'],
  },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      // 手写全局表（不引 globals 包）：浏览器与 Node 两侧混用是本项目的事实，
      // 有了这张表才能开 no-undef——否则「调用了一个没解构/没定义的函数」
      // 这类问题（0.10.1 的 toggleSel）会一路滑到运行时才炸。
      globals: {
        // 浏览器
        document: 'readonly', window: 'readonly', navigator: 'readonly', localStorage: 'readonly',
        sessionStorage: 'readonly', location: 'readonly', history: 'readonly', fetch: 'readonly',
        console: 'readonly', performance: 'readonly', crypto: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        queueMicrotask: 'readonly', structuredClone: 'readonly', requestAnimationFrame: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
        Blob: 'readonly', FormData: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        // Node
        process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
      },
    },
    rules: { ...BASE_RULES, 'no-undef': 'error' },
  },

  // ---- 分层约束 ----
  {
    // core 是零业务语义的基础层：常量、存储、diff、文件树、错误。
    // 它一旦依赖上层，复用性就没了——而这些正是别的项目要照搬的部分。
    files: ['src/core/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../modules/**', '../runtime/**', '../web/**'],
              message: 'core 是最底层，不得依赖 modules / runtime / web。',
            },
          ],
        },
      ],
    },
  },
  {
    // 功能域模块之间禁止互相依赖。需要共享的东西下沉到 core/。
    // 唯一的只读例外是 settings（基础模块），故不在禁列。
    //
    // 这份禁列是**逐模块枚举**的，因此每新增一个模块都必须回来补一行——
    // 漏补不会报错，只是新模块悄悄变成「谁都可以依赖」，规则随模块数增加持续衰减。
    files: ['src/modules/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../repos/*', '../skills/*', '../bundled/*', '../system/*', '../env/*', '../worktrees/*'],
              message: '模块之间不得互相依赖；共享逻辑请下沉到 core/。唯一例外是 ../settings/service.js。',
            },
          ],
        },
      ],
    },
  },
  {
    // system 是刻意的聚合模块（bootstrap 要一次拿齐各模块状态），是上述规则的例外
    files: ['src/modules/system/**/*.js'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // 前端：这条规则的价值最高——把 Node 侧代码 import 进视图，
    // Vite 会把 node: 内置模块一起打进浏览器包，构建期报错或运行期炸掉。
    //
    // files 覆盖 src/modules/** 全部视图文件（view.jsx 与拆出的 parts/*.jsx），
    // 以及 shared.js（前后端共用纯函数，会被打进浏览器包）：
    // 只列 web/frontend/** + view.jsx 会让 parts/* 落在所有分层规则之外（拆分时的实测洞）。
    files: ['src/web/frontend/**/*.{js,jsx}', 'src/modules/**/*.jsx', 'src/modules/*/shared.js'],
    rules: {
      // hook 的依赖数组在「声明那一刻」求职值——数组里引用了下方才声明的
      // const（patchUi / project 这类），运行时就是 TDZ 整页白屏。
      // 构建与单测都测不出来（0.10.0 实测连踩两次），只能 lint 期拦。
      // 函数声明有提升，放行；组件内先声明后使用不受影响。
      'no-use-before-define': ['error', { variables: true, functions: false, classes: true, allowNamedExports: false }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: '前端不能引用 Node 内置模块。',
            },
            {
              group: ['**/modules/*/index.js', '**/modules/*/service.js', '**/runtime/**', '**/core/**'],
              message:
                '前端只能 import 模块的 view.jsx / parts / shared，以及 web/frontend 下的组件与 api 客户端。index.js/service.js/runtime/core 是 Node 侧代码，拖进浏览器包会把 node: 内置模块一起带进来。',
            },
            {
              // 视图层同样禁止跨模块依赖（与上面 modules 层规则同一份禁列）——
              // flat config 同一文件被两块匹配时规则整条替换，所以必须在这里重复声明。
              group: ['../repos/*', '../skills/*', '../bundled/*', '../system/*', '../env/*', '../worktrees/*'],
              message: '模块之间不得互相依赖；共享逻辑请下沉到 core/。唯一例外是 ../settings/service.js。',
            },
          ],
        },
      ],
    },
  },
  {
    // 尺寸护栏：文件 / 函数按「有效行」计（跳过空行与注释），超标即 lint 失败。
    // 阈值依据拆分后实测：最大文件 ≈350 有效行（skills svc/queries.js）；
    // 全仓最大函数 = env 视图 EnvView（420 有效行）——450 恰在它上方，
    // 下一次有人写出巨石组件（如拆分前 442 行的 WorktreesView）当场拦截。
    // tests/ 不在此列：smoke.mjs 是有意的单文件状态化 E2E（见 README）。
    files: ['src/**/*.{js,jsx}'],
    rules: {
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 450, skipBlankLines: true, skipComments: true }],
    },
  },
]);
