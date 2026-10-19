# 調査レポート第2弾: 競合・権利、PSOLA の品質、UI、制作者の手法

> 2026-10-19 調査。4つのテーマを並行して調べた。主要な出典(★印)は直接開いて内容を確認した。
> 「事実」は出典に書かれていること、「推論」はこちらの考察。第1弾は [research.md](research.md)。

## 0. 要約(先に結論)

1. **位置づけは「人力のための道具」にする。** コミュニティは AI 声変換(RVC など)を「人力ではない」と明確に区別しており、合作で RVC を禁止した例もある。MADDAW は「生成AIを使わない、学習しない、端末内だけで処理する」を明示する。
2. **2026年に声の権利が明文化された。** 法務省の解釈指針、東京地裁の判決、日俳連のガイドラインが出ている。いずれも主な対象は AI だが、ツールとしては「素材の出典を記録する機能」と「声を配布しない設計」で備える。
3. **品質改善の最大の効き目は、ピッチマーク検出の作り直し。** 現在のピーク拾い方式を、Praat の相互相関追跡方式に置き換える。次に効くのは、持続区間で周期をランダムに選ぶことと、微小な揺らぎを足すこと。これで「ロボット声」を防げる。
4. **UI は乗り換える人の慣れを優先する。** ショートカットは REAPER・FL・Melodyne 互換にする。iPad は Logic for iPad 型のモード切り替えにする。色は色覚の違いに配慮し、線の種類と太さでも区別する。
5. **論点 B〜G への推奨は 6章。**

## 1. 競合と権利(AI 声変換、歌声合成)

### 1.1 AI 声変換と人力の関係(事実)
- 2023年から、so-vits-svc や RVC を使った音MADが作られている。
  - 出典: [note 制作記](https://note.com/eve_starlight/n/nf16338c035f2)
- コミュニティでは、人力(切り貼り・UTAU式など)と AI(RVC など)を分けて呼ぶべきだという主張がある。
  - 出典: [note](https://note.com/ageyakiatuyaki/n/ncce5c32b0099)
- ★ 2024年6月、ある音MAD合作の募集要項が RVC を使った歌唱を禁止した。使用が疑われる場合は、プロジェクトファイルのスクリーンショットを求める方針だった。これに反論する匿名記事も出ている。
  - 出典: [はてな匿名ダイアリー](https://anond.hatelabo.jp/20240614163428)
- bilibili の鬼畜区では AI を使った二次創作が急増し、「人間らしさ」が薄れることへの懸念も出ている。
  - 出典: [GameGeeker](https://gamegeeker.com/zh/news/ai-revives-huaqiang-buys-melon-bilibili-remix-boom)
- Seed-VC は学習なしで、1〜30秒の参照音声から歌声を変換できる。
  - 出典: [arXiv](https://arxiv.org/html/2411.09943v1)

### 1.2 声の権利(2024〜2026、★は確認済み)
- 2024年10月、声優26名が「NOMORE無断生成AI」を発足させた。
  - 出典: [inside-games](https://www.inside-games.jp/article/2024/10/16/160479.html)
- ★ **2026年8月7日、法務省が解釈指針を公表した。**
  - 声は氏名や肖像と同じく「人格の象徴」で、パブリシティ権などで保護される。
  - 声優や歌手の声を使った AI 楽曲を無断で公開すると、侵害になり得る。
  - 名前を明示した物まね芸は侵害に当たらない。
  - 声を明示的に保護する法律はまだない。
  - 出典: [さきがけ](https://www.sakigake.jp/news/article/20260807CO0119/)
- ★ **2026年9月30日、東京地裁が「声もパブリシティ権で保護される」と初めて判断した。**
  - 津田健次郎さんが TikTok の運営会社を訴えた裁判。
  - 動画の削除請求は退けられた。
  - 出典: [熊日](https://kumanichi.com/articles/2041247)
- ★ **2026年10月15日、日俳連が「音声に関する生成AI利用ガイドライン」を公表した。**
  - 学習・生成・利用の各段階で書面による同意を求め、まとめて同意させる「バイアウト契約」を禁止している。
  - 法的拘束力はない。二次創作(MAD など)への言及もない。
  - 出典: [弁護士ドットコム](https://www.bengo4.com/c_23/n_21058/)
- YouTube は、写実的な合成音声などの開示を義務化しており、声の類似検出も導入する予定。
  - 出典: [YouTube 公式ブログ](https://blog.youtube/news-and-events/disclosing-ai-generated-content)
- 中国では、2025年9月から AI 生成物への標識が義務化されている。
  - 出典: [CAC](https://www.cac.gov.cn/2025-03/14/c_1743654685896173.htm)

**推論**
- 現時点で狙われているのは「AI による声の生成」で、切り貼りの人力は直接の対象ではない。
- ただ、「実在の声を加工して公開する」点は人力も同じなので、論理が広がる可能性はある。
- ツールの設計で備える手段は次の3つ。
  - (a) 声のデータベースやプリセットを、公式には配布しない
  - (b) 素材をサーバーに上げず、端末内だけで処理する
  - (c) 素材の出典を記録して、投稿時の親作品登録やクレジット表記を助ける

### 1.3 歌声合成ツールとの違い(事実)

| ツール | 特徴 | 出典 |
|---|---|---|
| OpenUtau | MIT。Win/Mac/Linux。開発が活発。ブラウザ版はない。素材を音源にするには、音素の切り出しと oto 設定が必要 | [GitHub](https://github.com/stakira/OpenUtau) |
| VOICEVOX | 無料・オープンソース。2024年にソング機能を搭載 | [窓の杜](https://forest.watch.impress.co.jp/docs/news/1567478.html) |
| VOCALOID6 | VOCALO CHANGER で自分の歌唱をボイスバンクの声にできる。27,500円 | [AV Watch](https://av.watch.impress.co.jp/docs/news/1447632.html) |
| Rys Up Pitch Editor | ブラウザで音符単位のピッチ編集ができる。無料版は約3分・モノラルまで。サンプラー機能はない | [Rys Up](https://rysupaudio.com/tools/pitch-editor) |

**推論**: 「台詞1本を、そのまま鍵盤で弾ける楽器にする」ブラウザツールは、確認した範囲では存在しない。OpenUtau やほかの DAW 向けの書き出しを用意すれば、競合ではなく「前工程の道具」として共存できる。

### 1.4 普及のさせ方(事実と推論)
- ニコニ・コモンズでは、ツールも創作物として登録できる。子作品が親作品として登録すると、奨励金のスコアが親にも入る。
  - 出典: [ニコニコインフォ](https://blog.nicovideo.jp/niconews/179219.html)
- TapMV と同じ方法が使える(TapMV もコモンズに登録済み)。
- 晒しイベントや合作、英語圏のチュートリアル集([mmaker.moe](https://mmaker.moe/ytpmv/))が、知識の集まる場所になっている。
- 推論: 収益は寄付(FANBOX・Ko-fi)と、BOOTH での素材・プリセット頒布で得るのが現実的。

## 2. PSOLA の品質改善

### 2.1 ピッチマーク(声帯振動の位置)の検出
- 事実:
  - 5つの手法を比べたレビューでは、条件の分からない音声には SEDREAMS が推奨されている。雑音に最も強いのは ZFF と SEDREAMS。
    - 出典: [Drugman ほか](https://arxiv.org/abs/2001.00473)
  - ★ Praat の相互相関方式(cc)は次の手順でマークを決める。
    1. 有声区間の中央付近で、振幅が最大の点を種にする。
    2. 前の点から 0.8〜1.2 周期離れた範囲で、波形の相互相関が最大になる点を左右に順に探す。
    3. 見つけた点の位置は、放物線補間で精密にする。
    4. 相関が 0.3 未満の点は削除する。
    - ピーク拾い版(peaks)は周期がばらつきやすく、重ね合わせによる合成には向かない、と明記されている。
    - 出典: [Praat マニュアル cc](https://www.fon.hum.uva.nl/praat/manual/Sound___Pitch__To_PointProcess__cc_.html)、[peaks](https://www.fon.hum.uva.nl/praat/manual/Sound___Pitch__To_PointProcess__peaks____.html)
- 推論: Phase 0 の実装は、まさにピーク拾い方式だった。アニメやテレビの素材(BGM、残響、圧縮)では、周期の倍や半分を拾う誤りと、位相の揺れが出やすい。**cc 方式に置き換えるのが最優先。** 解析は事前に済ませるので、再生時の負荷は変わらない。

### 2.2 持続区間を伸ばすとき(シンセ化)
- 事実:
  - 同じ周期を規則的に繰り返すと、人工的な周期性(ロボット声)が出る。
    - 出典: [特許 EP1543503](https://patents.google.com/patent/EP1543503B1/en)
  - 無声部分を伸ばすと金属的な音になる。対策は、連続するフレームの時間を交互に反転させること。
    - 出典: [講義資料](https://people.engr.tamu.edu/rgutier/lectures/sp/l19.pdf)
  - 合成した母音には、周期の揺らぎ(jitter)と振幅の揺らぎ(shimmer)の両方を加えたものが最も自然に聞こえた。
    - 出典: [J. Voice 2017](https://repositorio.usp.br/item/002847736)
  - 歌声の f0 は、オーバーシュート、ビブラート、準備動作、微細な揺らぎの4つの成分で表すと自然になる(産総研の Saitou & Goto)。
    - 出典: [WASPAA 2007](https://staff.aist.go.jp/m.goto/PAPER/WASPAA2007saitou.pdf)
- 推論:
  - 持続区間の伸ばし方は「**安定した周期を10〜40個集め、その中から近いものをランダムに選び続ける**」にする。
  - それに加えて、わずかな揺らぎ(周期 0.3〜1%、振幅 0.2〜0.5dB、10Hz 以上の細かい揺れ)を加える。
  - 平坦化 100% でも、この揺らぎは残す。そうすれば「平坦なのに機械的ではない」音にできる。
  - 1周期だけをループするウェーブテーブルは、意図的な「シンセっぽさ」として別モードで提供する。

### 2.3 フォルマント、大きな移調、ステレオ
- 事実: Praat の Change gender は、サンプリング周波数の操作でフォルマントを動かし、重ね合わせでピッチと長さを変える。
  - 出典: [Praat](https://www.fon.hum.uva.nl/praat/manual/Sound__Change_gender___.html)
- 推論:
  - **フォルマントのずらし**: 各グレインを係数 α でリサンプルする。追加の負荷は補間1回分。
  - **大きな移調**: ±7 半音を超えたら、フォルマントを少しだけ追従させるオプションを用意する。「ミッキーマウス声」と「巨人声」を避けるため。
  - **ステレオ**: マークは左右の平均から1組だけ求め、両チャンネルに同じグレインを使う(定位が揺れないように)。

### 2.4 リアルタイム性能(事実と推論)
- 事実:
  - Chromium では AudioParam の数に比例して処理コストがかかる。
    - 出典: [cprimozic](https://cprimozic.net/blog/webaudio-audioworklet-optimization/)
  - `process()` の中では、メモリ確保や Promise を避ける。
    - 出典: [Mozilla Hacks](https://hacks.mozilla.org/2020/05/high-performance-web-audio-with-audioworklet-in-firefox/)
- 推論:
  - Worklet は1つにまとめ、その中にボイスを事前に確保しておく(例: 32 ボイス)。AudioParam は使わない。
  - まず JS で負荷を測る。目標は iPad で 24〜32 ボイスを CPU 50% 未満で鳴らすこと。足りなければ WASM(SIMD)に移す。

### 2.5 基準ピッチの決め方(聴覚研究)
- 事実:
  - 音程がすべる音の知覚ピッチは、終わり側に寄る。
    - 出典: [Nábělek 1973](https://link.springer.com/article/10.3758/BF03211361)
  - 短いビブラート音の知覚ピッチは、f0 を重み付けした時間平均になる。
    - 出典: [d'Alessandro & Castellengo](https://hal.archives-ouvertes.fr/hal-02008510)
- 推論: 重みは「音量 × 有声らしさ × 安定度(f0 があまり動いていない)」にし、中央値を取る。さらに持続区間を重視する。シンセ化マーカーが決まったら、持続区間の f0 で基準ピッチを計算し直すと、聞こえ方に近くなる。最頻値は不安定なので候補から外す。

## 3. UI・操作の慣習

### 3.1 乗り換える人のための互換操作(事実)
- REAPER:
  - S で分割、Shift+0 と Shift+9 で ±1 半音、Ctrl+Backspace でピッチを元に戻す
  - アイテムの端を Alt を押しながらドラッグすると、再生レートが伸縮する
  - 出典: [チートシート](https://hoard.reaperaccessibility.com/Tutorials%20and%20Demos/Text/reaper%20cheat%20sheet%20(written%20by%20Chris%20Turner).txt)
- FL Studio のピアノロール:
  - P で描画、E で選択、右クリックで削除
  - Alt でスナップを外す
  - 新しいノートは、直前に触ったノートと同じ長さになる
  - 出典: [FL マニュアル](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm)
- Melodyne:
  - 縦にドラッグすると半音単位で動き、Alt を押すとセント単位になる
  - ダブルクリックで、最も近い音程に合わせる
  - 出典: [Celemony](https://helpcenter.celemony.com/M5/doc/melodyneEditor5/en/M5tour_QuickStart_editor)
- VocalShifter:
  - 鉛筆で描き、右ドラッグで消す
  - 範囲を選んで右クリックすると、半音・セント単位のシフト、平均化、ビブラート付加などができる
  - 出典: [公式マニュアル](http://ackiesound.ifdef.jp/doc/vocalshifter/itemedit.html)

### 3.2 サンプラーが基準キーをどう見せているか(事実)
- GarageBand(iOS)のサンプラー:
  - 録音時にピッチを検出し、最も近い音名に合わせる
  - 「Detect Pitch」ボタンで、検出した値に戻せる
  - 開始・終了は青、ループは黄色のハンドルで表す
  - 出典: [Apple](https://support.apple.com/guide/garageband-iphone/use-the-sampler-chs392814a5/ios)
- Logic の Quick Sampler: 読み込み時に「元のまま」か「最適化(チューニングとループ点を自動設定)」を選べる。
  - 出典: [Apple](https://support.apple.com/en-asia/102041)

### 3.3 iPad のピアノロール(事実)
- Logic for iPad:
  - 「トリム/鉛筆/ブラシ/選択」のモードボタンで、操作の意味を切り替える
  - ノートを長押しすると拡大表示になり、精密に動かせる
  - Apple Pencil で精度が上がる
  - 出典: [Apple](https://support.apple.com/guide/logicpro-ipad/lpip3d423c4b/ipados)
- Cubasis: 選択と描画の2つのモード。ピンチで拡大・縮小。
  - 出典: [Steinberg](https://download.steinberg.net/downloads_software/Cubasis/Cubasis_3_Web_Help/ED_MIDI.html)

### 3.4 PC キーボードで鍵盤を弾く、日本語入力(IME)(事実)
- Ableton:
  - A の段が白鍵(A = C)、W・E・T・Y・U が黒鍵
  - Z/X でオクターブ、C/V でベロシティ
  - 出典: [解説](https://schoolofsynthesis.com/playing-notes-from-your-computer-keyboard-in-ableton-live)
- FL Studio: Ctrl+T で鍵盤モードを切り替える。オンの間は、1キーのショートカットが無効になる。
  - 出典: [FL マニュアル](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm)
- キーの割り当ては `KeyboardEvent.code`(物理的なキーの位置)で行う。IME で変換中は `isComposing` が真、または keyCode が 229 になる。
  - 出典: [MDN](https://developer.mozilla.org/docs/Web/API/KeyboardEvent/code)、[WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=165004)

### 3.5 iOS の音声まわり(事実)
- iOS 17.6 以降は、アプリを切り替えると AudioContext が "interrupted" になる。戻ってきたら、次のタップで再開する必要がある。
  - 出典: [WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=276016)
- `navigator.audioSession.type = "playback"` で、マナーモードでも音を鳴らせる。ただし、まだ標準として定着した機能ではない。
  - 出典: [MDN](https://developer.mozilla.org/docs/Web/API/AudioSession/type)

### 3.6 色と読みやすさ(事実)
- WCAG は「色だけで情報を伝えない」ことを求めている。Okabe-Ito パレットは、色覚の違いがあっても見分けやすい。
  - 出典: [W3C](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast)
- 推論: 元のピッチ(橙)と整えたあとのピッチ(黄)は、P型・D型の色覚では似て見える。元のピッチは細い破線、整えたあとは太い実線にして、線の形でも区別する。移調量の警告は、赤と緑ではなく、青と朱の組み合わせに数値も添える。

## 4. 制作者の手法と声

### 4.1 平坦化の使い方: 二極化していて、部分的にかける(論点 G)
- ★ 原型を残したいなら、VocalShifter の平均化はやめた方がよい。ピッチのずれがなくなって機械っぽくなるため。
  - 代わりに、REAPER のピッチベンドで「大雑把に」合わせ、ビブラートやピッチエンベロープで揺らぎを加える。
  - 機械っぽさの原因は次の4つとされている: ピッチのずれがない、変化がない、子音や息がない、人間が出せない高さ。
  - 出典: [note](https://note.com/54654658/n/n3ee005466dbd)
- ★ 人力の切り貼りでは、平坦化は「5〜10音に1度くらい」使う。
  - 主な用途は、フレーズの頭の「こぶし」(頭で音程が下がる現象)を消すこと。
  - 頭だけを部分的に平坦化し、後半は元の形を保つ使い方もある。
  - 出典: [ブログ](https://mekapi.hatenablog.com/entry/ar1878988)
- 初心者向けの講座は、平均化と自動補正でまっすぐにする手順を教えている。そのうえで「原型がなくならない程度」に留めるよう勧めている。
  - 出典: [note](https://note.com/madcreator/n/n402147958bda)
- 補正しすぎると「単調」になる。揺れている素材の方が良いこともある。
  - 出典: [ブログ](https://immortalt.hatenablog.com/entry/ar1845344)
- 仕上げにビブラートを足し直す例がある(ReaPitch、デチューンしたコピーを重ねる)。
  - 出典: [ブログ](https://rokkan2235500.hatenablog.com/entry/2018/05/18/213813)、[note](https://note.com/mad_doll_airbook/n/n24d3a48935ed)
- Melodyne の補正量のノブも 0〜100% で、解説記事は 60〜80% から始めるよう勧めている。
  - 出典: [mastering.com](https://mastering.com/melodyne/)

### 4.2 音の終わり(論点 F)
- 標準は短いフェード(約 0.02 秒、数十 ms)。
  - 出典: [ブログ](https://kh40qsh1388.hatenablog.com/entry/2024/12/08/100700)、[note](https://note.com/masteralice3104/n/n2dd8b3060677)
- 一方で、「発音が終わる瞬間」は人間らしさが出る部分なので活かしたい、という声がある。
  - 出典: [note](https://note.com/54654658/n/n3ee005466dbd)、[Scrapbox](https://scrapbox.io/lec-a/%E3%82%BB%E3%83%AA%E3%83%95%E5%90%88%E3%82%8F%E3%81%9B)
- ★ Otomad Helper(Vegas 用)には、終わりの扱いを選ぶ設定がある。
  - **Truncate**: ノートの長さで切る。
  - **Legato**: ノートの長さを超えて延長する。延長量は「延長しない/1拍まで/1小節まで/無制限」から選び、次の音までの間隔に応じて働く。
  - 既存のツールでも、「ノートを離したあとも鳴らすか」が明示的な選択肢になっている。
  - 出典: [Otomad Helper ドキュメント](https://otomadhelper.readthedocs.io/v4/audio.html)

### 4.3 普通のシンセ音は使われているか(論点 D)
- ドラムやベースも素材から作るのが主流。
  - 例: ドラムは 8〜13 トラック、ベースは低い「n」「m」の音をシンセ化して作る。
  - 出典: [ブログ](https://immortalt.hatenablog.com/entry/ar1845344)、[note](https://note.com/mad_doll_airbook/n/n24d3a48935ed)
- 足りない部分は、原曲を混ぜる(原曲使用)。素材だけで再現する「原曲不使用」は難度が高いとされる。
  - 出典: [萌娘百科](https://zh.moegirl.org.cn/%E9%9F%B3MAD)(本文は未確認で、検索結果の抜粋による)
- シンセは「素材を鳴らす仕組み」として使われていて、のこぎり波などの音そのものを聴かせる例は見つからなかった。
  - 出典: [ブログ](https://rokkan2235500.hatenablog.com/entry/2018/05/18/213813)、[note](https://note.com/la_0274/n/n2a579d903ee3)
- 加工しすぎて無機質になった音を「Fake Sample」と皮肉る言い方がある。素材らしさが評価の軸になっている。
  - 出典: [ニコニコ大百科](https://dic.nicovideo.jp/a/ytpmv)(コメント欄の記述)

### 4.4 ピッチの変え方(論点 B)
- 長さ保持(élastique Soloist)を既定にしている人が多い。
  - 出典: [Scrapbox](https://scrapbox.io/ngbox/%E4%BF%BA%E3%81%8C%E3%81%99%E3%82%8BREAPER%E8%A8%AD%E5%AE%9A)、[ブログ](https://kh40qsh1388.hatenablog.com/entry/2024/12/08/100700)
- ★ 原型が残る移調量の目安は「-5〜+5 くらい」(単位の明記はないが、文脈から半音と読める)。別の制作者は ±3 が限界と感じている。
  - 出典: [note](https://note.com/54654658/n/n3ee005466dbd)、[Scrapbox](https://scrapbox.io/lec-a/%E3%82%BB%E3%83%AA%E3%83%95%E5%90%88%E3%82%8F%E3%81%9B)
- ★ 速度ごと変える方式(Otomad Helper の Lock Stretch and Pitch)も、「古いスタイル」向けの選択肢として残っている。ほかに、極短のパルスで音程を作る Granular Oscillator(シンセ化に相当)もある。
  - 出典: [Otomad Helper ドキュメント](https://otomadhelper.readthedocs.io/v4/audio.html)

### 4.5 シンセ化と子音
- 伸ばすのは母音だけで、子音は伸ばさない(目安は半小節)。
  - 出典: [note](https://note.com/madcreator/n/n402147958bda)
- サ行の子音を削ると、タ行に聞こえてしまう。
  - 出典: [ブログ](https://immortalt.hatenablog.com/entry/ar1845344)
- s・t・k・ʃ は、母音との間隔を保つ必要がある。濁音と清音の聞き分けは、子音の長さに大きく左右される。
  - 出典: [Scrapbox](https://scrapbox.io/lec-a/%E3%82%BB%E3%83%AA%E3%83%95%E5%90%88%E3%82%8F%E3%81%9B)
- 母音をループで伸ばすと音程がうねるので、Melodyne で直線に直す、という方法がある。ループの長さやクロスフェードの具体的な数値は見つからなかった。
  - 出典: [Scrapbox](https://scrapbox.io/ngbox/2024-12-23)
- → 設計 v1.1 の「頭部(子音)は伸ばさずに1回だけ鳴らす」は、制作者の手作業の作法とそのまま一致している。

### 4.6 ハモりと和音
- 基本は「5半音下(4度下)」。上ハモりは目立ちすぎる。ハモりはパンを左右に約70%振る。
  - 出典: [note](https://note.com/madcreator/n/n402147958bda)、[ブログ](https://kh40qsh1388.hatenablog.com/entry/2024/12/08/100700)
- ハモりは付けられるだけ付けると、印象が大きく変わる。オクターブ違いを重ねる手法もある。
  - 出典: [ブログ](https://immortalt.hatenablog.com/entry/ar1845344)

### 4.7 時間がかかる作業
- 流れの調整だけで、作業時間の約3割を使う。
  - 出典: [ブログ](https://mekapi.hatenablog.com/entry/ar1878988)
- REAPER で並べる → 書き出す → VocalShifter で調声する → 戻す、という往復が標準になっている。
  - 出典: [ブログ](https://tsukiri.hateblo.jp/entry/2018/12/18/190000)
- サンプラーでは、基準音を手で合わせる必要がある。
  - 出典: [note](https://note.com/la_0274/n/n2a579d903ee3)
- 初心者は人力を「難易度が高い」と感じて避けている。
  - 出典: [note](https://note.com/kk09020/n/n8821079a9626)

### 4.8 まだ読めていない重要資料
シンセ化の具体的な手法(ループの長さ、唸りを抑える方法)を扱ったブロマガ記事が2本ある。原本が archive.ph にしか残っておらず、取得できなかった。人の手で読むことを勧める。
- 「音MAD素材のシンセ化」
- 「無限に音を伸ばす人力タイムストレッチ　シンセサイズとヒューマナイズ」
- 一覧: [ngbox アーカイブ](https://scrapbox.io/ngbox/%E9%9F%B3MAD%E5%BD%B9%E7%AB%8B%E3%81%A4%E3%83%96%E3%83%AD%E3%83%9E%E3%82%AC%E8%A8%98%E4%BA%8B%E3%82%A2%E3%83%BC%E3%82%AB%E3%82%A4%E3%83%96)

## 5. 設計 v1.1 への変更提案

| # | 変更 | 根拠 |
|---|---|---|
| 1 | ピッチマーク検出を Praat の cc 方式に置き換える | 2.1 |
| 2 | 持続区間の伸ばし方の既定を「周期プールからのランダム選択 + 微小な揺らぎ」にする | 2.2 |
| 3 | 基準ピッチの重みに安定度を加え、持続区間を重視する。最頻値は候補から外す | 2.5 |
| 4 | フォルマントのずらしは、グレインのリサンプルで行う。大きな移調では少しだけ自動追従させる | 2.3 |
| 5 | PC の鍵盤は Ableton 互換(A の段が白鍵)にする。M で切り替え、IME を検知したら知らせる | 3.4 |
| 6 | 素材エディタの色と線: 元のピッチは細い破線、整えたあとは太い実線。移調量の警告は青と朱にし、数値も添える | 3.6 |
| 7 | 「生成AI不使用・端末内処理」を明記する。素材の出典メモ欄を持たせる | 1.1、1.2 |
| 8 | 書き出しに「楽器を WAV または SFZ で書き出す」を加え、REAPER や OpenUtau と共存できるようにする | 1.3 |

追加の変更提案(制作者調査から)

| # | 変更 | 根拠 |
|---|---|---|
| 9 | 平坦化は楽器全体だけでなく、**ノートごと・素材の範囲ごと**にもかけられるようにする(「頭のこぶしだけ平坦化」に対応) | 4.1 |
| 10 | 平坦化と対になる「揺らぎを戻す」つまみ(ビブラートの深さ・速さ、ゆっくりした揺れ)を Phase 1 に入れる | 4.1、2.2 |
| 11 | **ハモりボタン**: 選んだノートを複製し、5半音下(既定)や3度上などに置き、パンを左右に振る | 4.6 |
| 12 | 楽器プリセットに「ベース(低い n・m 音をシンセ化)」「ドラム(アタックの強い素材、ワンショット)」を用意する | 4.3 |
| 13 | 移調量の警告は、±5 半音で注意、±7 半音で警告にする | 4.4 |

## 6. 論点 B〜G への推奨

| 論点 | 推奨 | 確度 | 主な根拠 |
|---|---|---|---|
| **B. ピッチの変え方の既定** | **長さ保持(PSOLA)を既定にする。** 楽器ごとに「速度連動(昔ながらの音)」へ切り替えられるようにする | 高 | 制作者の多くが Soloist を既定にしている。サンプラー方式の「高音で切れる」が欠点として挙がっている。速度連動も古いスタイルとして需要がある(4.4) |
| **C. フェーズの振り分け** | 基本はそのままにして、次を入れ替える。**Phase 1 に「揺らぎを戻すつまみ」と「ピッチマーク検出の cc 方式化」を追加する。Phase 2 に「ハモりボタン」「範囲ごとの平坦化」を追加する** | 中 | 4.1、2.1、4.6 |
| **D. 普通のシンセ音** | **入れない**(少なくとも Phase 3 までは)。代わりに、ベース・ドラム用の楽器プリセットと、ハモりの機能に力を入れる。打ち込みの確認用に、単純な正弦波の「ガイド音」だけは用意してもよい | 中 | 素のシンセ音を聴かせる例が見つからない。素材らしさが評価の軸(4.3) |
| **E. Phase 0 のコード** | **検証ページは削除する。** pYIN、基準ピッチ判定、PSOLA は Worklet 向けに作り直して残す。ピッチマーク検出は cc 方式で書き直す。テストと合成音声の生成器は引き継ぐ | 高 | 2.1(ピーク拾い方式は不適)。基準ピッチ判定は Phase 0 で検証済み |
| **F. 語尾(リリース区間)** | **Phase 1 に入れる。ただし既定はオフ**(ノートを離したら約20msでフェードする)。オンにすると、語尾の区間をそのまま鳴らす。延長の上限は「なし/1拍/1小節/無制限」から選ぶ(Otomad Helper の Legato と同じ考え方) | 中 | 標準は短いフェード。一方で、終わりを活かしたいという声と、既存ツールの先例がある(4.2) |
| **G. 平坦化の既定値** | **既定は 0%**(元の抑揚のまま。REAPER と同じ)。プリセットとして「人力(30%、こぶし除去)」「シンセ化(100%、揺らぎ付き)」を用意する。100% にしても、細かい揺らぎ(2.2)は既定で残す | 中 | 使い方は二極化している。原型を残すことが重視されている。シンセ化は目的次第(4.1)。Melodyne の慣行 |

## 7. 未確認・今後の課題
- 制作者への直接のヒアリング(特に、平坦化のプリセット値と、ハモりボタンの需要)
- 4.8 のブロマガ記事2本(シンセ化の具体的な手法)
- bilibili、Reddit、萌娘百科の本文(取得がブロックされた)
- iPad 実機での PSOLA の同時発音数と、Safari の OfflineAudioContext で Worklet が動くか
