'use strict';

/**
 * 构建配置。
 *
 * 分发形态：
 *   - NSIS 向导安装包：安装时可自定义安装目录；卸载默认保留 harness 缓存，勾选后一并清理
 *   - portable：免安装单目录
 *
 * 体积说明：内置 harness 依赖树约 213MB / 2.5 万文件，作为 extraResources 随包分发，
 * 首次运行时释放到 %APPDATA%\DeepSeekHarness\harness\<version>，之后升级/回滚都不写安装目录。
 */

const path = require('node:path');

const harnessBundle = path.join(__dirname, 'harness-bundle');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ai.deepseek.harness.desktop',
  productName: 'DeepSeek Harness',
  copyright: 'DeepSeek Harness Desktop',

  directories: {
    output: 'dist',
    buildResources: 'build',
  },

  files: [
    'src/**/*',
    'package.json',
    '!**/*.map',
  ],

  extraResources: [
    // 重要：electron-builder 会把 extraResources 里的 node_modules 目录整个过滤掉
    // （实测：直接指 harness-bundle 目录，打进去只剩 package.json 等 3 个文件）。
    // 因此 harness 依赖树以 tar.gz 形式分发，首次运行时由应用解包。
    { from: path.join(__dirname, 'harness-bundle.tar.gz'), to: 'harness-bundle.tar.gz' },
    // 随包 node 运行时：node.exe 与 npm 分开列出（同样为了绕开上面的过滤）
    { from: path.join(__dirname, 'node-runtime', 'node.exe'), to: 'node/node.exe' },
    { from: path.join(__dirname, 'node-runtime', 'npm'), to: 'node/npm' },
    // 第三方许可证清单（MIT/Apache-2.0/BSD 要求随分发附上；含 LGPL 组件声明）
    { from: path.join(__dirname, 'THIRD-PARTY-NOTICES.txt'), to: 'licenses/THIRD-PARTY-NOTICES.txt' },
  ],

  asar: true,
  icon: path.join(__dirname, 'build', 'icon.ico'),
  compression: 'maximum',

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,   // ← 安装时可自定义安装路径
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DeepSeek Harness',
    deleteAppDataOnUninstall: false,            // 默认保留 %APPDATA% 缓存（含已下载的 harness 版本）
    include: 'build/installer.nsh',             // 卸载时提供"同时删除缓存数据"勾选
    uninstallDisplayName: 'DeepSeek Harness ${version}',
  },

  portable: {
    artifactName: '${productName}-${version}-portable.${ext}',
  },

  // 应用本体更新通道：electron-updater 需要一个发布源。
  // 拿到地址后取消注释对应 provider 即可（harness 更新通道与此无关，已经可用）。
  // publish: [{ provider: 'github', owner: '<owner>', repo: '<repo>' }],
};
