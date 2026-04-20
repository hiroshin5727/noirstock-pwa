# NoirStock GitHub Pages 配置版 v4

このフォルダは **GitHub Pages にそのまま置き換えやすい配置版** です。

## 置き換え手順
1. GitHub の `noirstock-pwa` リポジトリを開く
2. 既存ファイルを削除するか、上書きアップロードする
3. このフォルダの **中身** をそのままリポジトリ直下へアップロードする
4. `Settings > Pages` で `main` / `/(root)` になっていることを確認
5. 公開URLを開き、必要なら Safari の共有メニューから「ホーム画面に追加」

## 大事な点
- ZIPのままではなく、**中身のファイル** をアップロードします
- `index.html` がリポジトリ直下にある必要があります
- Service Worker の更新反映のため、公開後に一度 Safari で再読み込みしてください
- ホーム画面追加済みの場合、古い版が残ることがあるので、一度アプリを終了してから開き直してください

## この配置版に含むもの
- 在庫ステータス変更で販売済み登録
- 移行JSON取り込みUI
- 画像OCR導線（対応ブラウザのみ）
- オフライン用 Service Worker
- IndexedDB ローカル保存

## 公開URL例
https://<GitHubユーザー名>.github.io/noirstock-pwa/
