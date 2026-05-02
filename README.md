# NoirStock PWA v6.3

iPhone向け、黒基調、オフライン前提の在庫・販売・帳簿管理PWAです。

## v6.3で追加したもの

- 販売証跡画像OCR導線
- ブラウザOCR対応環境での画像文字認識
- OCR候補チップ表示
- 候補タップで販売入力へ反映
- OCR結果を `ocrRecords` として保存
- OCR失敗時のテキスト貼り付け解析フォールバック
- v6.2以前のJSON互換維持

## 注意

iPhone SafariではブラウザOCR APIが利用できない場合があります。その場合は、iPhoneのLive Textで文字をコピーし、販売入力シートの取引画面テキスト欄へ貼り付けて解析してください。

## GitHub Pages配置

ZIPを解凍し、以下の構成を崩さずリポジトリ直下へアップロードしてください。

```text
index.html
manifest.webmanifest
sw.js
.nojekyll
assets/
src/
```
