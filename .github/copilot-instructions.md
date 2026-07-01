# Copilot Instructions

このリポジトリで GitHub Copilot を使用する際の共通ルールです。

## ブランチ命名規則

- **フォーマット**: `feature/MYP-{チケット番号}-{英語kebab-case}`
- **ベースブランチ**: 原則 `develop`
- **タイトルが日本語の場合**: 英訳してkebab-caseに変換する
- **例**:
  - `feature/MYP-3423-csv-bulk-upload`
  - `feature/MYP-3434-invoice-detail-page`
  - `feature/MYP-3691-add-logging`
  - `feature/MYP-3712-add-withdrawn-field`

## プロジェクト概要

- **Google Apps Script (GAS)** プロジェクト（clasp で管理）
- ファイル命名規則: `be_`(バックエンド), `fe_`(フロントエンド), `db_`(DB層), `fe_page_`(ページ), `fe_part_`(共通パーツ)
- 詳細なコーディングルールは `docs/CODING_RULES.md` を参照
