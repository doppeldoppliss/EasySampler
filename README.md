# MADDAW

素材を入れたら、DAW に渡せる音源になる。音MADの「シンセ化」(素材を切り出し、音程を平らにして1音に伸ばし、サンプラー用の WAV にする)を、ブラウザの1画面で行うツール(開発中)。
Windows・Mac・iPhone・iPad の Safari / Chrome で動く。生成AIは使わず、素材は端末の外に出ない。
設計は [docs/design.md](docs/design.md)(v2.0)。v1.2 までの「DAW」構想は [docs/design-v1.2.md](docs/design-v1.2.md) に残してある。

## 現在: Phase 1(単音 WAV が出る)

1. 素材(声や効果音のファイル)を開くと、ピッチカーブ・ピッチマーク・セント単位の基準ピッチ・シンセ化マーカー(頭部 / 持続区間 / 語尾)を自動で解析する。
2. 波形の上で範囲とマーカーを直し、目標の音名と長さ(拍数 + BPM、または秒)を決める。画面の鍵盤や PC のキーボードで試し弾きできる。
3. 「共有 / 保存」で単音 WAV を書き出す。iPhone / iPad では共有シートから GarageBand やファイルに渡せる。

| 部分 | 場所 |
|---|---|
| 解析(pYIN、cc 方式のピッチマーク、基準ピッチ) | `src/analysis/` |
| シンセ化マーカーの自動提案、楽器の設定とプリセット、書き出し設定 | `src/instrument/` |
| 音声エンジン(PSOLA の素材シンセ。Worklet・書き出し・テストで共通) | `src/engine/engine.ts` |
| 書き出し(オフライン描画、WAV、共有 / 保存) | `src/export/`、`src/audio/wav.ts` |
| AudioWorklet と解析 Worker | `src/engine/worklet.ts`、`src/workers/` |
| 素材エディタ・鍵盤・画面 | `src/ui/`、`src/main.ts` |

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # 解析・エンジン・書き出しのテスト (Vitest)
npm run build     # dist/ に静的ファイル(Cloudflare 向け。_headers 付き)
```

### iPhone / iPad で試す
AudioWorklet は安全な接続(HTTPS)でしか動かないため、LAN 内では HTTPS で配信する。

```bash
npm run dev:lan
```

表示された `https://192.168.x.x:5173` を Safari で開く。証明書の警告が出るので、許可して進める。
URL に `?bench` を付けると、24 ボイスを鳴らしたときの処理負荷を測るボタンが出る。
