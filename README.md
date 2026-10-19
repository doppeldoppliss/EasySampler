# MADDAW

素材の平均ピッチを自動判定し、ピアノロールのノートに合わせて素材の音程を上下させて曲にするブラウザDAW(開発中)。
設計は [docs/design.md](docs/design.md)。

## 現在: Phase 0 検証ページ

素材(またはデモの合成音声)を読み込み、pYIN でピッチカーブと平均ピッチ(重み付き中央値/平均/最頻値)を求める。
そのうえでテストフレーズに合わせて、3方式で変換して比べる。

| 方式 | 実装 |
|---|---|
| 再生速度(基準) | `src/dsp/resample.ts` |
| TD-PSOLA | `src/dsp/psola.ts`(自作、Worker で実行) |
| Signalsmith Stretch | `src/dsp/signalsmith.ts`(WASM、OfflineAudioContext で実行) |

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # 解析・DSPのテスト (Vitest)
```

### iPad で試す
AudioWorklet は安全な接続(HTTPS)でしか動かないため、LAN 内では HTTPS で配信する。

```bash
npm run dev:lan
```

表示された `https://192.168.x.x:5173` を iPad の Safari で開く。証明書の警告が出るので、許可して進める。
「4. 環境と計測結果」の「結果をコピー」で、計測値をテキストで持ち帰れる。
