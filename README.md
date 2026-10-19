# MADDAW

素材を入れたら、もう楽器。声や効果音を鍵盤で弾ける、ブラウザの音MAD用DAW(開発中)。生成AIは使わず、素材は端末の外に出ない。
設計は [docs/design.md](docs/design.md)。

## 現在: Phase 1(素材が楽器になる)

素材(声や効果音のファイル)を開くと、ピッチカーブ、ピッチマーク、セント単位の基準ピッチ、シンセ化マーカーを自動で解析し、すぐに鍵盤で弾けるようになる。
画面の鍵盤か、PC のキーボード(A の段が白鍵、Z/X でオクターブ)で弾く。

| 部分 | 場所 |
|---|---|
| 解析(pYIN、cc 方式のピッチマーク、基準ピッチ) | `src/analysis/` |
| シンセ化マーカーの自動提案、楽器の設定とプリセット | `src/instrument/` |
| 音声エンジン(PSOLA の素材シンセ。Worklet・テスト・計測で共通) | `src/engine/engine.ts` |
| AudioWorklet と解析 Worker | `src/engine/worklet.ts`、`src/workers/` |
| 素材エディタ・鍵盤 | `src/ui/` |

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # 解析・エンジンのテスト (Vitest)
```

### iPad で試す
AudioWorklet は安全な接続(HTTPS)でしか動かないため、LAN 内では HTTPS で配信する。

```bash
npm run dev:lan
```

表示された `https://192.168.x.x:5173` を iPad の Safari で開く。証明書の警告が出るので、許可して進める。
画面下の「負荷を測る」で、24 ボイスを鳴らしたときの処理負荷を確認できる。
