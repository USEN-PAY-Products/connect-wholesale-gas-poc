const fs = require('fs');
const path = require('path');

/**
 * src/frontend 内の index.html, style.css, app.js を
 * 1つのファイルに統合して dist/index.html に出力します。
 */
function build() {
  const srcDir = path.join(__dirname, 'src/frontend');
  const distDir = path.join(__dirname, 'dist');

  // ディレクトリがない場合は作成
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir);
  }

  // 各ファイルの読み込み
  let html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(srcDir, 'css/style.css'), 'utf8');
  const js = fs.readFileSync(path.join(srcDir, 'js/app.js'), 'utf8');

  // HTMLの置換
  // index.html内に <!-- CSS_PLACEHOLDER --> と <!-- JS_PLACEHOLDER --> を書いておくと綺麗に置換できます
  // もしくは単純にタグの直前に挿入します
  const finalHtml = html
    .replace('</head>', `<style>\n${css}\n</style>\n</head>`)
    .replace('</body>', `<script>\n${js}\n</script>\n</body>`);

  fs.writeFileSync(path.join(distDir, 'index.html'), finalHtml);
  
  // ついでにバックエンドのファイルも dist にコピー（名前を server.gs に変えるのが clasp のコツ）
  const backendSrc = path.join(__dirname, 'src/backend/server.js');
  if (fs.existsSync(backendSrc)) {
    fs.copyFileSync(backendSrc, path.join(distDir, 'server.js'));
  }

  // GASの必須ファイル(appsscript.json)も dist にコピーする
  const manifestSrc = path.join(__dirname, 'appsscript.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, path.join(distDir, 'appsscript.json'));
  } else {
    console.warn('⚠️ appsscript.json がプロジェクトルートに見つかりません！');
  }

  console.log('✨ Build complete: dist/index.html and dist/server.js generated.');
}

build();