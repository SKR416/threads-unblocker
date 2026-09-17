# Threads 訪客完整檢視器 (Threads Unblocker)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Brave-success.svg)](#安裝方式)

免登入即可暢快瀏覽 Threads（`threads.net` / `threads.com`）完整文章、串文與留言回覆的 Chrome / Chromium 瀏覽器擴充套件。

---

## 💡 開發背景與特色

當未登入使用者造訪 Threads 貼文時，平台通常會在頁面加載後彈出強制登入對話框，並在背景將頁面鎖死、甚至透過 React 客戶端渲染將原本已存在於伺服器端（SSR）的貼文與回覆內容清除。

本擴充套件採用**五層攔截防禦架構**，徹底解決上述限制：

- 🚀 **免登入完整閱讀**：無痛瀏覽原文、長串討論與全部留言。
- 🚫 **杜絕強制登入彈窗**：在頁面首次繪製（First Paint）前即攔截並隱藏登入視窗。
- 🔓 **無阻礙頁面滾動**：自動解除 `html`、`body` 以及內層滾動容器（如 `#scrollview`）的滾動鎖定。
- 🛡️ **SSR 內容防卸載保護**：防止 React 客戶端水合（Hydration）時將伺服器端渲染的文章清空。
- ⚡ **雙層 User-Agent 偽裝**：結合網路層（`declarativeNetRequest`）與 DOM 主執行環境（`MAIN` world）偽裝搜尋引擎爬蟲，取得完整 SSR 頁面且不洩漏 Client Hints。

---

## 🛠️ 五層攔截引擎架構 (v2.0)

```
┌────────────────────────────────────────────────────────┐
│                      Threads 頁面載入                    │
└──────────────────────────┬─────────────────────────────┘
                           │
 ┌─────────────────────────▼─────────────────────────────┐
 │ Layer A: 網路與環境層偽裝                               │
 │ • declarativeNetRequest 修改 Request Header (Googlebot)│
 │ • 移除 sec-ch-ua 等 Client Hints 避免洩漏身分           │
 │ • 於 MAIN world 複寫 navigator.userAgent               │
 └─────────────────────────┬─────────────────────────────┘
                           │
 ┌─────────────────────────▼─────────────────────────────┐
 │ Layer B: 早期宣告式 CSS 注入                            │
 │ • blocker.css 於 document_start 注入                  │
 │ • 強制隱藏 modal 對話框與半透明遮罩 (Overlay)         │
 └─────────────────────────┬─────────────────────────────┘
                           │
 ┌─────────────────────────▼─────────────────────────────┐
 │ Layer C: 動態 DOM 監聽與攔截 (MutationObserver)         │
 │ • 持續捕捉動態生成的登入容器並設定 pointer-events: none  │
 │ • 阻擋全螢幕攔截圖層                                   │
 └─────────────────────────┬─────────────────────────────┘
                           │
 ┌─────────────────────────▼─────────────────────────────┐
 │ Layer D: 深度滾動鎖定解除器 (Scroll Lock Neutralizer)   │
 │ • 監控 html / body 之 overflow 與 position             │
 │ • 解除 Threads 專用滾動容器 (#scrollview) 的捲動限制    │
 └─────────────────────────┬─────────────────────────────┘
                           │
 ┌─────────────────────────▼─────────────────────────────┐
 │ Layer E: SSR 快照與防止清空機制                         │
 │ • 捕捉初始 HTML 中的文章結構                           │
 │ • 防止未登入狀態下 React unmount 造成頁面空白          │
 └───────────────────────────────────────────────────────┘
```

---

## 📦 安裝方式（開發者模式）

本套件採用標準 **Manifest V3** 規範開發，適用於 Google Chrome、Microsoft Edge、Brave 等所有 Chromium 核心瀏覽器：

1. **下載或 Clone 本專案**：
   ```bash
   git clone https://github.com/SKR416/threads-unblocker.git
   ```
2. **開啟瀏覽器擴充功能管理頁面**：
   - Chrome：在網址列輸入 `chrome://extensions/`
   - Edge：在網址列輸入 `edge://extensions/`
3. **啟用開發者模式**：
   - 開啟右上角的「**開發者模式 (Developer mode)**」開關。
4. **載入擴充套件**：
   - 點擊左上角的「**載入未封裝項目 (Load unpacked)**」。
   - 選擇剛才下載的 `threads-unblocker` 專案資料夾。
5. **開始使用**：
   - 直接前往任一 [Threads](https://www.threads.net/) 頁面或特定貼文，即可開始免登入無障礙瀏覽！

---

## 📂 專案結構

```plaintext
threads-unblocker/
├── manifest.json       # 擴充套件清單設定檔 (Manifest V3)
├── content.js          # 核心五層攔截引擎 (注入 MAIN World 執行)
├── blocker.css         # 早期宣告式樣式覆寫 (消除彈窗與恢復版面)
├── rules.json          # declarativeNetRequest 網路層偽裝規則
└── README.md           # 專案繁體中文說明文件
```

---

## ⚠️ 免責聲明 (Disclaimer)

- 本專案僅供個人學術研究、技術探討與網頁無障礙體驗測試之用。
- Threads 及其商標權屬於 Meta Platforms, Inc. 所有。
- 請勿將本套件用於任何違反相關服務條款或大量爬蟲之行為。

---

## 📄 授權條款 (License)

本專案採用 [MIT License](LICENSE) 授權開源。