function doGet() {
  // dist/index.html を読み込んでブラウザに返す
  // evaluate() を使うことで、HTML内のスクリプトレット（<?!= ?>）も実行可能になります
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('卸システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}