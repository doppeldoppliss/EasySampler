# MADDAW

素材を入れたら、DAW に渡せる音源になる。音MADの「シンセ化」(素材を切り出し、音程を平らにして1音に伸ばし、サンプラー用の WAV にする)を、ブラウザの1画面で行うツール(開発中)。
Windows・Mac・iPhone・iPad の Safari / Chrome で動く。生成AIは使わず、素材は端末の外に出ない。
設計は [docs/design.md](docs/design.md)(v2.0)。v1.2 までの「DAW」構想は [docs/design-v1.2.md](docs/design-v1.2.md) に残してある。

## 現在: Phase 2 まで(音源として渡せる)

1. 素材(声や効果音のファイル)を開くと、ピッチカーブ・ピッチマーク・セント単位の基準ピッチ・シンセ化マーカー(頭部 / 持続区間 / 語尾)を自動で解析する。
2. 波形の上で範囲とマーカーを直し、目標の音名と長さ(拍数 + BPM、または秒)を決める。長い素材は「区間を追加」で何か所でも切り出せる。画面の鍵盤や PC のキーボードで試し弾きできる。
3. 形式を選んで「共有 / 保存」する。
   - **単音 WAV**: どのサンプラーでも。音名と出典メモが WAV に入る。
   - **ループ WAV**: ループ範囲を `smpl` チャンクに埋め込み、継ぎ目をクロスフェードで消したもの。
   - **マルチサンプル音源(zip)**: ±1 オクターブを 3 半音おきに、それぞれの高さで PSOLA で作った WAV と、`.sfz`(sforzando など)・`.dspreset`(Decent Sampler。iPhone / iPad でも無料)の定義。
   - 区間が複数あれば「すべての区間をまとめて保存」で 1 つの zip に(設定 JSON 同梱)。
4. 設定(区間・マーカー・つまみ・音名)は素材ごとに端末に残り、同じ素材を開き直すと戻る。JSON として保存・読み込みもできる。

| 部分 | 場所 |
|---|---|
| 解析(pYIN、cc 方式のピッチマーク、基準ピッチ) | `src/analysis/` |
| シンセ化マーカーの自動提案、楽器の設定とプリセット、書き出し設定 | `src/instrument/` |
| 音声エンジン(PSOLA の素材シンセ。Worklet・書き出し・テストで共通) | `src/engine/engine.ts` |
| 書き出し(オフライン描画、ループ化、SFZ / dspreset、zip、設定 JSON、共有 / 保存) | `src/export/`、`src/audio/wav.ts` |
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
