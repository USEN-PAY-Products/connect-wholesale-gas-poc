'use strict';

const fs   = require('fs');
const path = require('path');

const SRC_DIR  = path.join(__dirname, 'src/frontend');
const DIST_DIR = path.join(__dirname, 'dist');

// ---------------------------------------------------------------------------
// resolveIncludes: @@include <relPath> を再帰的に展開する
// ---------------------------------------------------------------------------

/**
 * HTML 文字列内の `<!-- @@include <relPath> -->` を
 * baseDir からの相対パスで読み込んで再帰的に展開する。
 *
 * @param {string} html     - 処理対象の HTML 文字列
 * @param {string} baseDir  - include パスの基点ディレクトリ
 * @returns {string}        - 展開後の HTML 文字列
 */
function resolveIncludes(html, baseDir) {
  const RE = /<!--\s*@@include\s+([\w/.\-]+)\s*-->/g;
  return html.replace(RE, (_match, relPath) => {
    const absPath = path.join(baseDir, relPath);
    if (!fs.existsSync(absPath)) {
      console.warn(`[build] WARNING: include target not found: ${absPath}`);
      return `<!-- MISSING: ${relPath} -->`;
    }
    const included = fs.readFileSync(absPath, 'utf8');
    // 展開されたファイルの include 基点はそのファイルのディレクトリ
    return resolveIncludes(included, path.dirname(absPath));
  });
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
function build() {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1. index.html を読み込み、@@include を再帰展開
  const rawHtml = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  let   html    = resolveIncludes(rawHtml, SRC_DIR);

  // 2. CSS をインライン化（<link rel="stylesheet" href="css/style.css"> を置換）
  const cssPath = path.join(SRC_DIR, 'css/style.css');
  const css     = fs.readFileSync(cssPath, 'utf8');
  html = html.replace(
    /<link[^>]+href="css\/style\.css"[^>]*\/?>/,
    `<style>\n${css}\n</style>`
  );

  // 3. app.js をインライン化（<script src="js/app.js"> を置換）
  const jsPath = path.join(SRC_DIR, 'js/app.js');
  const js     = fs.readFileSync(jsPath, 'utf8');
  html = html.replace(
    /<script\s+src="js\/app\.js"><\/script>/,
    `<script>\n${js}\n</script>`
  );

  // 4. images/ をコピー
  const srcImages  = path.join(SRC_DIR, 'images');
  const distImages = path.join(DIST_DIR, 'images');
  if (fs.existsSync(srcImages)) {
    if (!fs.existsSync(distImages)) fs.mkdirSync(distImages, { recursive: true });
    for (const file of fs.readdirSync(srcImages)) {
      fs.copyFileSync(path.join(srcImages, file), path.join(distImages, file));
    }
  }

  // 5. 出力
  const outPath = path.join(DIST_DIR, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`[build] Done -> ${outPath}  (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
}

build();
