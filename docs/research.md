# 調査レポート: 音MADの作り方と、MADDAW の売り

> 2026-10-19 調査。Web 上で公開されている解説・ツール資料・技術資料をもとにした。3方向(制作手順、既存ツールと不満、技術)を並行して調べ、主要な出典は直接開いて確認した。
> 「出典」は資料に書かれていること。「推論」はこちらの考察。

## 1. いまの音MAD制作(音声側)

### 1.1 主流の道具立て: 4つのソフトの組み合わせ
ユーザー(実制作者)の知見では、**REAPER + VocalShifter + WaveTone + Melodyne** の組み合わせが主流。調査結果とも一致する。

| ソフト | 主な役割 | 動く環境・価格 | 出典 |
|---|---|---|---|
| **REAPER** | 中心となるDAW。素材の切り出し、半音単位のピッチ変更(Shift+0/9)、élastique Soloist による声質を保ったピッチ変更、伸縮、サンプラー(RS5K)、テイクピッチエンベロープ | Win/Mac。有料(安価) | [otomad.jp](https://otomad.jp/archives/94)、[tumblr 解説](https://www.tumblr.com/v0xov/64852902962/)、[note](https://note.com/lance2457/n/n885b8d23b846) |
| **VocalShifter** | 素材のピッチ編集。ピッチの直線化・平均化、「半音単位で描写」、TIME で伸縮、FRM でフォルマント、MIDI を使ったピッチ修正、ビブラート付加。**シンセ化**(素材を伸ばして単音にする)の定番 | **Windows のみ**。LE は無料(16bit/48kHz まで、VST連携なし)、通常版は2,000円 | [ytpmv.info](https://ytpmv.info/How-to-Stretch-1/)、[窓の杜](https://forest.watch.impress.co.jp/library/software/vocalshift/)、[note](https://note.com/madcreator/n/n402147958bda) |
| **WaveTone** | 原曲の耳コピ(スペクトルをピアノロール風に表示)、テンポ解析、素材の音程を調べる | **Windows のみ**。無料 | [窓の杜レビュー](https://forest.watch.impress.co.jp/docs/review/596996.html)、[ブロマガ](https://site.nicovideo.jp/ch/userblomaga_thanks/archive/ar1346634) |
| **Melodyne** | 高品質なピッチ編集(人力の歌わせ)。フォルマント保持 | Win/Mac。高価 | [ブログ](https://mekapi.hatenablog.com/entry/ar1878988) |

**ソフト間の受け渡し**
- **シンセ化**: REAPER で切り出す → フェードを外して WAV で書き出す → VocalShifter LE で読み込み、「単音ボーカル用」で平均化・自動補正し、TIME で伸ばす → WAV で書き出す → REAPER に戻してサンプラーに割り当てる。
  - 出典: [note](https://note.com/madcreator/n/n402147958bda)、[tumblr](https://www.tumblr.com/v0xov/64852902962/)
- **人力**: REAPER で1音ずつ書き出す → VocalShifter で音程を合わせる → REAPER で組み立てる。プロジェクトは「編集用・切り出し用・書き出し用」に分ける。
  - 出典: [ブログ](https://mekapi.hatenablog.com/entry/ar1878988)
- 無料の LE 版には VST 連携がないため、往復はファイル経由になる。
- **往復をなくす手段もあるが、どれも有料か、品質に妥協がある。**
  - VocalShifter 製品版の VST 連携([窓の杜](https://forest.watch.impress.co.jp/docs/news/20130716_607830.html))
  - REAPER 上で Melodyne を ARA で使う(有料、[reaper.blog](https://reaper.blog/2019/03/melodyne-ara/))
  - REAPER の機能だけで完結させる中級者向けの手順もある(ピッチエンベロープ、ReaPitch。[note](https://note.com/lance2457/n/n885b8d23b846))。ただし、VocalShifter の平均化のようなピッチカーブ編集はできない。

**VocalShifter の主な機能**(素材シンセで再現すべき機能の基準になる)
- ピッチの自動解析と表示(編集前と編集後の線を重ねる)、ペンでの描画、1セント単位のシフト
- 平坦化、半音単位への丸め、平均値補正、スケールを指定した自動補正
- ビブラートの付加・強調・抑制、MIDI を貼り付けたピッチ補正
- TIME(制御点による伸縮)、FRM(フォルマント)、音量の折れ線
- 出典: [窓の杜レビュー](https://forest.watch.impress.co.jp/docs/review/589889.html)、[公式ダウンロードページ](https://ackiesound.ifdef.jp/download.html)

**VocalShifter の弱点**
- ノイズの多い素材では、ピッチの解析を誤る。
- 保存のときに別のファイルを誤って上書きしやすい。
- 伸ばすと子音が潰れる。
- 出典: [note](https://note.com/lance2457/n/n885b8d23b846)、[ブログ](https://mekapi.hatenablog.com/entry/ar1878988)、[ytpmv.info](https://ytpmv.info/How-to-Vocaloid/)

**WaveTone の主な機能**
- スペクトル表示、テンポ・コードの自動解析、メロディの MIDI 化、区間ループ、ボーカルカット
- 音程の表示は、分かりにくいという声もある。
- 出典: [窓の杜](https://forest.watch.impress.co.jp/docs/review/20130423_596996.html)、[ブロマガ](https://site.nicovideo.jp/ch/userblomaga_thanks/archive/ar1845344)

### 1.2 工程
1. BGM を除去する(UVR など)。素材を切り出し、文字起こしする。この段階で数日かかることもある。
2. BPM を調べ、グリッドを合わせる(WaveTone のテンポ解析)。
3. 素材の音程を調べる(耳、WaveTone、チューナー)。
4. 音程を合わせる(REAPER で半音単位、VocalShifter で直線化・平均化、フォルマントは ±1 目盛り程度)。
5. 長さを合わせる(母音の安定した部分だけを伸ばし、子音は伸ばさない)。
6. 打ち込む。方式は次の3つ。
   - 手で置いてコピペする
   - サンプラー(RS5K、vital など)で鳴らす
   - midi2item(MIDI からアイテムを一括生成する ReaScript)を使う
7. ミックス、書き出し、映像との同期(AviUtl など)。

出典: [ブロマガ ar1346634](https://site.nicovideo.jp/ch/userblomaga_thanks/archive/ar1346634)、[ブログ](https://mekapi.hatenablog.com/entry/ar1878988)、[note](https://note.com/la_0274/n/n2a579d903ee3)、[ytpmv.info 人力](https://ytpmv.info/How-to-Vocaloid/)

### 1.3 打ち込み方式の長所と短所(出典: [note la_0274](https://note.com/la_0274/n/n2a579d903ee3))

| 方式 | 長所 | 短所 |
|---|---|---|
| サンプラー(RS5K) | ADSR を自由に設定できる | 原型(元の声質)が残りにくい。モノラルになる。**高音ほど素材が短くなり、途中で切れる**。ピッチベンドが難しい |
| midi2item | ステレオ。原型が残る。高音でも違和感が少ない | サステインなどの設定がしにくい。ピッチベンドが難しい |
| vital(シンセ) | ステレオ。フィルターやエンベロープが使える。素材を長く作る必要がない。ピッチベンドを読める | 原型がほぼ残らない |
| Kerovee(ピッチ補正) | 原型が残る | シンセ用途には向かない。モノラルになる |

→ **どの方式にも一長一短があり、「全部の長所を持つもの」がない。**

## 2. 制作者の痛点(出典つき)

| # | 痛点 | 出典 |
|---|---|---|
| P1 | 4つのソフトを行き来する。WAV で書き出して読み込み直す往復が必要。プロジェクトに互換性がない | [ytpmv.info](https://ytpmv.info/How-to-Stretch-1/)、[chaosinism](https://chaosinism.github.io/posts/script-otomad/) |
| P2 | VocalShifter と WaveTone は Windows 専用。Vegas 系の自動化ツールも Windows 専用 | [窓の杜](https://forest.watch.impress.co.jp/library/software/vocalshift/)、[OtomadHelper](https://github.com/otomad/OtomadHelper) |
| P3 | 素材の音程が分からない。耳で判断するか、汎用ツールに頼るしかない。**喋り声は平均律に乗っていないので、半音単位では合わない** | [ブロマガ ar1845344](https://site.nicovideo.jp/ch/userblomaga_thanks/archive/ar1845344)、[知恵袋](https://detail.chiebukuro.yahoo.co.jp/qa/question_detail/q11287360646) |
| P4 | ピッチを変えると劣化する。**±3 半音程度が限界**という感覚。異性の曲は声域の差で崩れる | [Scrapbox lec-a](https://scrapbox.io/lec-a/%E3%82%BB%E3%83%AA%E3%83%95%E5%90%88%E3%82%8F%E3%81%9B)、[note](https://note.com/lance2457/n/n885b8d23b846) |
| P5 | 伸ばすと「間抜け」になり、子音が潰れる。伸ばせるのは母音の安定部分だけ | [ytpmv.info](https://ytpmv.info/How-to-Stretch-1/) |
| P6 | サンプラー方式の欠点(高音で切れる、モノラル、原型が消える、ピッチベンドしにくい) | [note la_0274](https://note.com/la_0274/n/n2a579d903ee3) |
| P7 | とにかく時間がかかる。切り出しが一番退屈。流れの調整だけで作業時間の約3割を使う | [ブロマガ](https://site.nicovideo.jp/ch/userblomaga_thanks/archive/ar1346634)、[ブログ](https://mekapi.hatenablog.com/entry/ar1878988) |
| P8 | REAPER の初期設定でつまずく(スナップ、自動フェード、テンポを変えると音声の速度も変わる、IME でキーが効かない) | [note](https://note.com/madcreator/n/n402147958bda) |
| P9 | スマホ・タブレットで「歌わせる」音MADを作る手段が、事実上ない(紹介されるのは音ハメ用の動画アプリばかり) | [Filmora](https://filmora.wondershare.jp/video-editing-app/create-mad-video.html)、[Koala フォーラム](https://forum.loopypro.com/discussion/51587/help-with-samples-and-getting-the-right-key-into-koala-beatmaking) |

## 3. 競合と空白

- **ブラウザDAW**(BandLab、Audiotool、Signal など): 自前の声を鍵盤に割り当てて、長さを保ったままノートごとに音程を変える、という機能がないか弱い。音MADで使われている例も見つからなかった。
  - 出典: [BandLab](https://www.audeobox.com/learn/bandlab/bandlab-sampling/)、[Signal](https://signalmidi.app/)
- **音MAD専用の補助ツール**(Otomad Helper、YTPMVE、midi2item、swood、pitch-extractor): 「MIDI → 素材を自動配置」に特化している。どれも別のソフトの上で動くスクリプトで、素材のピッチ編集やシンセ化は外部のソフトに頼っている。
  - 出典: [OtomadHelper](https://github.com/otomad/OtomadHelper)、[YTPMVE](https://github.com/Cantersoft/YTPMVE)、[bfut ReaScripts](https://github.com/bfut/ReaScripts)、[pitch-extractor](https://github.com/dpren/pitch-extractor)
- **推論**: 「素材のピッチを分析・編集する(VocalShifter / WaveTone の役割)」と「楽器として演奏・打ち込む(REAPER + サンプラーの役割)」を、1つの画面で、OS を問わず行えるツールは見当たらない。ここが空白。

## 4. MADDAW の売り(候補)

痛点への効き目と、実現しやすさ(Phase 0 の成果を含む)で順位を付けた。

### ★1 「VocalShifter + サンプラー」を1画面に(P1, P2, P7)
素材を読み込んでから、切り出し、音程の判定、ピッチカーブの編集、シンセ化、鍵盤への割り当て、ピアノロールでの打ち込みまでを、書き出しの往復なしで行える。
- 編集はすべて非破壊にする(元の素材への参照を保ったまま、パラメータとして持つ)。
- 有料の組み合わせ(Melodyne の ARA 連携、VocalShifter 製品版の VST 連携)なら往復は減らせる。MADDAW は、それを**無料で、OS を問わず、音MAD向けの操作で**実現する、という位置づけにする。
- 何度でもやり直せて、往復のたびに音質が落ちることもない。
- ブラウザで動くので、Mac・Chromebook・iPad でも使える。VocalShifter と WaveTone が Windows 専用であることへの直接の答えになる。

### ★2 素材の音程を自動で、セント単位で判定する(P3)
- 「この素材は D4 の −37 セント」まで出す。そうすれば、半音単位では合わない喋り声でも、ノートにぴったり合う。
- Phase 0 で検証済み(pYIN による判定で、誤差は数セント)。
- 判定結果は、波形の上にピッチカーブとして表示し、手で直せるようにする。WaveTone で調べる手間がなくなる。

### ★3 「抑揚の残し具合」を1本のスライダーで決める(P3, P4)
- VocalShifter の「平均化・直線化」に相当する操作を、0〜100% の連続した量にする。
  - 0% = 元の抑揚のまま(REAPER のピッチ変更と同じ)
  - 100% = 完全に平坦(シンセ化・ロボット声)
- Melodyne の熟練者も補正を 100% にせず 60〜97% で止める、という実践がある(技術調査より)。
- 平坦にするほど台詞が歌に聞こえやすい、という研究もある(Speech-to-Song 錯覚: [Kent](https://research.kent.ac.uk/speech-to-song-illusion)、[Groenveld 2020](https://pure.uva.nl/ws/files/50348829/Groenveld2020_Article_IStillHearAMelodyInvestigating.pdf))。
- 「人力」と「シンセ化」の両方を、1つの操作でまかなえる。

### ★4 サンプラー方式の欠点をすべて潰した「素材シンセ」(P5, P6)
la_0274 の比較表で、各方式が持っていた長所を1つの楽器にまとめる。

| 欠点 | 対策 |
|---|---|
| 高音で途中で切れる | 長さ保持モード(PSOLA)なら、高い音でも素材は短くならない |
| 伸ばすと間抜けになる | **シンセ化マーカー**: 子音部分は1回だけ鳴らし、母音の安定部分だけをループ・伸長する(子音を保護する) |
| 原型が残らない | 長さ保持とフォルマント保持で、元の声質を保つ。昔ながらの速度連動モードにも切り替えられる |
| モノラルになる | ステレオ素材はステレオのまま扱う |
| ピッチベンドが難しい | ピアノロールにピッチベンドとグライドを書ける |
| ADSR が使えない | アンプのエンベロープ(ADSR)とフィルターを持つ |

### ★5 劣化の目安を見せる(P4)
- 移調量に応じて、ノートを色で警告する(±3 半音を超えたら注意、など)。
- 声域が合わないときは「1オクターブ下の素材を使う」などの選択肢を示す。

### ★6 音MAD向けの初期設定(P8)
- スナップは素材の頭(発音位置)に吸着させる。分割時の自動フェードはしない。テンポを変えても素材の速度は変えない。
- キーボードショートカットは IME の影響を受けない作りにする(TapMV で実績あり)。

### ★7 iPad で「歌わせる」音MADが作れる(P9)
画面の鍵盤とタッチ操作に対応したピアノロールで、作れる人がまだほとんどいない領域を取りに行く。

### 後回しにする候補
- MIDI の読み込み(耳コピ済みのデータを使う)。原曲のスペクトルをピアノロールの背景に表示する(WaveTone の代わり)
- 無音での自動分割と文字起こしによる素材ライブラリ(P7。Whisper 系は重いので、別のフェーズで検討)
- 動画を参照用に読み込むこと(映像との同期。TapMV との連携は当面行わない方針)

## 5. 技術面の裏付けと注意点(技術調査より)

- **ライセンス**
  - Signalsmith Stretch は MIT で使える。
  - Rubber Band は GPL なので使わない。
  - SoundTouch は LGPL の扱いが曖昧で、フォルマント保持もない。
  - [Signalsmith](https://github.com/Signalsmith-Audio/signalsmith-stretch)、[Rubber Band](https://breakfastquay.com/rubberband/license.html)
- **TD-PSOLA**
  - 声のフォルマントを鮮明に保てる。Signalsmith 自身も「PSOLA ほどシャープではない」と認めている。
  - 既製の JS 版はないので、自作する(Phase 0 で実装・テスト済み)。
- **iPad**
  - Web MIDI は Safari 26.5 でも非対応([caniuse](https://caniuse.com/midi))。
  - タブが使えるメモリは 300〜500MB 程度で、超えるとタブが落ちる([WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=269777))。
  - → 素材とキャッシュのメモリ予算を 200〜300MB に収める設計にする。
- **参考になる OSS**
  - openDAW(AGPL): 設計だけを参考にし、コードは流用しない。
  - GridSound(AGPL): ピアノロールの参考。
  - WAM 2.0: 将来のプラグイン境界の候補。

## 6. 設計への反映案(推論)
- 売りの中心は ★1〜★4 に置く。キャッチコピー案:
  - 「VocalShifter とサンプラーが1つになった、ブラウザで動く音MAD用DAW」
  - 「素材を入れたら、もう楽器」
- 楽器(素材シンセ)の設定項目に、次の3つを加える。
  - **抑揚の残し具合**(★3)
  - **シンセ化マーカー**(子音を保護する部分と、ループする部分。★4)
  - **ピッチカーブの手描き修正**(★2)
- Phase 1 の完了基準に、次の2つを加える。
  - 「素材を読み込んで30秒以内に、鍵盤で弾ける状態になる」
  - 「REAPER + VocalShifter で行っていたシンセ化を、往復なしで再現できる」

## 7. 未確認事項
- 制作者への直接のヒアリングは行っていない。特に ★3・★4 が刺さるかどうかは、確認したい。
- Reddit(r/YTPMV)、bilibili、萌娘百科は、取得できなかったか、読めなかった。
- Signalsmith と PSOLA の、iPad 実機での CPU 負荷と同時発音数。
- Melodyne が音MADでどこまで使われているかは、一次資料が少なかった(ユーザーの知見では主流)。
