# DSH ボットを Muse の VM に移す手順

DSH（DeepSeek Harness）の Slack ボット（<@U0C9C7BNVB5>）を、Muse（<@U0CCCH69XMW>）の VM で動かすための手順。
Muse にはプロンプトでしか頼めないので、VM 側の作業はすべて `deploy/linux/setup.sh` のサブコマンドにしてある。
Mac 側（owner）の作業は、秘密の暗号化と、切り替え時の Mac 側 Slack チャンネルの停止だけ。

**2026-10-24 時点の方針（owner 決定）: キットを作って VM で `check` まで通し、切り替え（cutover）は後で判断する。**
Mac の DSH はそのまま動かしておく。**2026-10-25: VM の `check` は通った**（下の「VM の確認結果」）。依頼文 2b（git の名義、
/etc/environment のプロキシ、自動復旧の cron）も済んだ。残りは切り替えの判断。

## VM で動くもの

- DSH 本体は npm 公開版の CLI `@deepseek-ai/dsh`（Mac のデスクトップアプリと同じ 0.2.1-rc.2）。`dsh --profile slack` で、
  Mac の desktop プロファイルと同じバンドル（dsh-base + dsh-web-app + auto-review）を Node のサーバーとして動かす。
  GUI はなく、DSH 自身の Web サーバーは 127.0.0.1:4198 だけで待つ。
- Slack チャンネルはこのリポジトリの `src/`（Mac で動いているものと同じコミット）。設定は Mac の `~/.dsh/cordis.patch.yml` の
  slack-channel 行と同じ（`maxConcurrentTurns: 1`、`mentionRewrites`、surface ガード、チーム名簿）。
- **モデルは NVIDIA だけ（owner の決定、2026-10-25）:** GLM-5.3 → GLM-5.3-flash → DeepSeek-v4.1-flash（どれも NVIDIA）。
  Mac のチェーンにある opencode-go と deepseek-official は VM では使わない。DeepSeek の API キーは Web 検索・取得
  （`web_search` / `web_fetch` が使う DeepSeek の Search & Fetch API）のためだけに渡す。
- すべて `~/.dsh-slack` の中: DSH のホーム（`DSH_HOME=~/.dsh-slack/home`。VM に `~/.dsh` があっても読まない・変えない）、
  共有エージェント設定（`DSH_AGENTS_HOME=~/.dsh-slack/agents`。Muse の `~/.agents` は読まない）、Node、dsh CLI、秘密、ログ。
- エージェントの作業場所は `~/work`（`DSK_WORKDIR` で変更可）。
- 秘密: Slack トークンは `~/.dsh-slack/secrets/slack.json`、API キー（NVIDIA = モデル / DeepSeek = Web 検索）は
  `~/.dsh-slack/home/.env`（DSH が公式に読む場所）。どちらも 600。GitHub は VM の `gh auth token`（Muse の gh ログイン）を
  DSH 起動時に読む。Mac のトークンはコピーしない。
- bash ツールのコマンドは Mac と同じ `permissionPreset: workspace-write` のサンドボックスの中で動く（作業場所と `/tmp` 以外は
  読み取り専用）。Linux の DSH は bubblewrap（`bwrap`）、無ければ Landlock を使い、どちらも使えないと**コマンドを 1 つも実行しない**
  （`no sandbox backend is usable`。サンドボックスなしで動かす設定にはしない）。`check` の `command sandbox` 行で分かる。
- サービスは systemd の `dsh-slack.service` 1 つ。`start --cutover` まで作られるだけで起動しない。Slack チャンネルの設定
  （`~/.dsh-slack/slack-channel.patch.yml`）はサービスだけが読むので、`check` が Slack のソケットにつなぐことはない。
- **VM が作り直されると `/home/hatch` 以外は消える**（2026-10-25 に判明。`/etc/systemd/system` のサービスも消え、ボットは
  自分では戻らない）。生き残るのは Muse 自身の cron だけなので、Muse の cron から 10 分ごとに `setup.sh start-saved` を回す
  （依頼文 2b）。Claude ボットのキットと同じ形:
  - `start --cutover` の前、または `stop` の後（`~/.dsh-slack/wanted` が無い）→ 何もしない
  - 動いていて Slack につながっている → 何もしない
  - 動いていない → `install` をやり直して（設定・秘密・セッション・入れた DSH はそのまま）起動
  - 動いているが、env ファイルのプロキシがトンネルを断り、ほかの設定（下）なら通る → `net-refresh`（プロキシ行を書き直して再起動）
  - サービスに渡すプロキシ設定は、`/etc/environment` のものが通ればそれ、通らなければ実行したシェルのもの（`install` /
    `net-refresh` / `start-saved` 共通）。シェルのプロキシ URL には実行ごとの認証情報
    （user:pass@）が入っていて、Muse の cron の実行ごとのものは数分で断られる（407）。`/etc/environment` のプロキシ URL には認証情報が
    入っておらず、プロキシは認証情報なしの CONNECT を通す（2026-10-25、Claude キットの netcheck と opencode ボットで確認）。
    シェルのものを写すと、次の cron でまた写し直す再起動の繰り返しになる（opencode ボットで 10 分ごとに起きた。/etc/environment
    に替えてからは止まった）。
  - 動いているが、直近 3 回の Slack ソケット接続がすべて失敗 → `net-refresh`
  - `start` / `stop` とロック（`~/.dsh-slack/.lock`）を共有するので、人の `stop` とぶつからない。動いたときの記録は
    `~/.dsh-slack/logs/start-saved.history`（`status` が最後の 5 件を出す）。再起動は動いているターンを中断する（キューには戻る）。

## Mac から移らないもの（切り替えを判断するときに見る）

| もの | VM では |
|---|---|
| 既存スレッドの会話（228 スレッド、セッション 361 MB。Mac のパス前提） | 持ち越さない。既存スレッドで次にメンションされると、直近 20 件の発言を文脈に新しいセッションで始まる |
| 有効なスケジュール 15 件（うち 9 件が Slack スレッドのセッション） | 移らない。Mac の DSH アプリが開いている限り Mac で実行され続ける |
| `soren-prod-vnic` への ssh（tailnet 経由。直近 3 日で約 180 回） | VM は tailnet にいないので届かない |
| Mac の Docker で動かすテスト用コンテナ（`docker exec canary759` など） | VM に Docker があるかは未確認 |
| `~/work` のクローン（docich / twica / soren / agent-guards …） | VM で必要に応じて clone し直す（gh は azumag でログイン済み） |
| Hermes の `~/work/wagyu-sync/.state` の読み取り | Hermes が Mac にいる間は読めない |
| 切り替えの瞬間に Mac で待っていた依頼（pending キュー） | 引き継がれない。切り替え後に Slack で再依頼 |

## 流れ

| # | どこで | 何を |
|---|---|---|
| 1 | Muse に依頼 | clone → `install` → `keygen`。公開鍵 `dsk-pub1:…` と環境情報を返してもらう |
| 2 | Mac | 公開鍵に向けて秘密を暗号化（`dsk-sealed1:…` の 1 行ができる） |
| 3 | Muse に依頼 | `import` → `check`。結果を返してもらう（**2026-10-25 通過**） |
| 3b | Muse に依頼（依頼文 2b） | `git-identity`、/etc/environment のプロキシで `check`、`start-saved` を手で 1 回、10 分ごとの cron 登録 |
| 4 | owner | 切り替えるか判断（上の表） |
| 5 | Mac | Mac の DSH の Slack チャンネルを止める（同じ Slack アプリで 2 つ動くと、イベントが振り分けられて両方おかしくなる） |
| 6 | Muse に依頼（依頼文 3） | `install`（消えたサービスとプロキシ設定を作り直す）→ `start --cutover` |
| 7 | Slack | DSH にメンションして返事が来るか見る |

## 依頼文 1（セットアップ）

```text
<@U0CCCH69XMW> お願いです。DSH の Slack ボット（<@U0C9C7BNVB5>）をあなたの VM でも動かせるように準備します。今回はセットアップと確認まで。ボット本体はまだ起動しないでください（Mac で動いている同じボットと Slack のイベントを取り合ってしまうため）。

1. clone（すでにあれば、そのディレクトリで git pull --ff-only）
   git clone https://github.com/azumag/dsh-slack-channel.git ~/dsh-slack-channel
2. セットアップ（プロキシの環境変数が入った、いつものシェルで実行してください。sudo 不要。Node 24 と DSH の CLI が ~/.dsh-slack に入ります。数分かかります）
   ~/dsh-slack-channel/deploy/linux/setup.sh install
   - 「lingering is off」と出たら: sudo loginctl enable-linger $(id -un)（できなければ、その旨を報告）
   - 「no usable systemd」と出たら: 表示された @reboot の行を crontab に追加
3. 秘密の受け渡し用の鍵を作る
   ~/dsh-slack-channel/deploy/linux/setup.sh keygen
   出力された dsk-pub1: で始まる 1 行を、このスレッドにそのまま返信してください（公開鍵なので貼って大丈夫です。~/.dsh-slack/handoff-key.json は秘密鍵なので VM の外に出さないでください）。
4. 次も報告してください: install の出力の最後の 25 行 / uname -m と OS / uname -r / id -un / gh auth status で誰としてログインしているか（トークンの値は貼らない）/ docker が使えるか（docker version の 1 行目、無ければ「なし」）/ bwrap --version（無ければ「なし」）/ ~/work にあるディレクトリの一覧

やらないでほしいこと:
- setup.sh start は実行しない（合図するまで）
- ~/.dsh や ~/.agents（あなた自身のものがあれば）には触れない。このセットアップは ~/.dsh-slack の中で完結します
- トークン・API キー・パスワード・鍵ファイルの中身を Slack に貼らない
- エラーが出たら、システムの設定を変えて回避せず、エラー出力をそのまま報告する
```

## Mac 側: 秘密を暗号化する

Muse が返してきた `dsk-pub1:…` を使う。出力の `dsk-sealed1:…` は、その VM の秘密鍵でしか開けない（鍵は 1 回開けると消える）。

```sh
cd ~/work/dsh-slack-channel
node deploy/secrets.mjs seal 'dsk-pub1:…'
```

Mac の DSH の設定ファイルから直接読む（値は画面に出ない）:

- Slack トークン 2 つ: `~/.dsh/cordis.patch.yml` の slack-channel 行の `botToken` / `appToken`
- API キー 2 つ: `~/.dsh/.credentials.yaml` の `refs` の `NVIDIA_API_KEY`（モデル）/ `DEEPSEEK_API_KEY`（Web 検索だけ）
  （キットのテンプレートが使うものだけ。ほかも渡すなら `--keys NAME,NAME…`）

GitHub のトークン（Mac の `~/.dsh/cordis.patch.yml` の MCP 行）は渡さない。VM では VM 自身の `gh auth token` を使う。

## 依頼文 2（秘密を入れて確認）

```text
<@U0CCCH69XMW> 続きです。暗号化した秘密を渡します（あなたの VM の秘密鍵でしか開けません）。

cd ~/dsh-slack-channel && git pull --ff-only
~/dsh-slack-channel/deploy/linux/setup.sh install --reconfigure
~/dsh-slack-channel/deploy/linux/setup.sh import 'dsk-sealed1:…ここに貼る…'
~/dsh-slack-channel/deploy/linux/setup.sh check

check の出力をそのまま返信してください（秘密の値は出ません。モデルの確認で 1〜3 分かかります）。Slack のソケットにはつながないので、まだ start はしないでください。
```

`check` で見るところ:

- `✓ dsh CLI — 0.2.1-rc.2`: DSH の CLI が入った。
- `✓ Slack channel plugin — loads on this Node`: Slack チャンネルのコードがこの Node で読める。
- `✓ command sandbox — bwrap` または `— Landlock, fully enforced`: bash ツールがコマンドを実行できる。`✗ command sandbox — none usable`
  なら、ボットはコマンドを 1 つも実行できない（下の「bubblewrap を入れる」）。
- `✓ DSH config — profile "slack" composes with the Slack channel overlay`: プロファイル + 設定 + Slack チャンネルの組み立てが通る（起動はしない）。
- `✓ Slack bot token — bot dsh (U0C9C7BNVB5) in azumaya`: 同じボットのトークンが入った。
- `✓ Slack app token — Socket Mode URL issued (not connected)`: app トークンが有効。
- `✓ Slack socket host — … reachable`: ソケットの接続先まで届く（ソケットは開かない）。
- `✓ API keys` と `· model chain`: キーの名前（NVIDIA_API_KEY, DEEPSEEK_API_KEY）と、Slack のモデルチェーン（NVIDIA だけ）。
- `✓ web search — DeepSeek Search API answered`: Web 検索のキーとプロキシ経由の経路が通る（1 回だけ検索する）。
- `✓ model nvidia/… — answered OK in N s (dsh headless)`: VM の DSH が NVIDIA のモデルを呼べた。既定は flash の 1 つ。
  `check --all-routes` でチェーンの全モデル（主モデル GLM-5.3 は 1 回に数分かかる）。
- `· GitHub CLI — logged in as …` と `✓ GitHub MCP token`: ボットはこのアカウントで GitHub を操作する。
- `· git user.name — …`: ボットのコミットの名義。未設定なら
  `setup.sh git-identity "azumag" azumag@users.noreply.github.com`（`~/.gitconfig` は変えない）。
- `· network — proxy settings: …`: サービスの環境にあるプロキシ変数の名前。check はサービスと同じ環境（env ファイルだけ）で走る。
  プロキシで失敗したら `setup.sh netcheck` の出力を返してもらう。シェルとサービスでプロキシ設定が違う（`DIFFERENT`）なら、
  プロキシが効いているシェルで `setup.sh net-refresh`（env ファイルのプロキシ行だけ書き直し、起動済みなら再起動。値は出ない）。

### VM の確認結果（2026-10-25、Muse の報告）

最初の `check` は 4 項目が「the proxy refused the tunnel」で失敗した（env ファイルに写したプロキシ設定が、install から check
までの間に古くなった）。同じシェルで `net-refresh` → `check` で **all checks passed**:

- `✓ command sandbox — Landlock, fully enforced`（カーネル 7.0.0-39-generic。bubblewrap は不要）
- `✓ Slack bot token — bot dsh (U0C9C7BNVB5) in azumaya` / app token / socket host（HTTP 200）
- `✓ web search — DeepSeek Search API answered`
- `✓ model nvidia/z-ai/glm-5.3-flash — answered OK in 169 s`
- `· GitHub CLI — logged in as azumag` / `· git user.name — not set`（依頼文 2b で設定する）

プロキシ設定が古くなる件は、`start-saved` が env ファイルのプロキシを試して、断られていれば `/etc/environment` の設定
（通るとき）か cron のシェルの設定で `net-refresh` する（上の「VM で動くもの」）。cron のシェルの認証情報は数分で断られ、
`/etc/environment` のものは認証情報なしで通る（上）。

**依頼文 2b の結果（2026-10-25 ~02:50 JST、Muse の報告）:** 874e052 に更新。git の名義 azumag
<azumag@users.noreply.github.com>（ボットの env だけ）。`net-refresh` → `network settings taken from /etc/environment`。
`netcheck` ではシェル・env ファイル・/etc/environment のプロキシ設定がすべて同じ値で、どれも slack.com / api.github.com /
integrate.api.nvidia.com に CONNECT 200 → HTTP 200。`check` は all checks passed（glm-5.3-flash が 213 s で回答）。`start-saved`
は not wanted（exit 0）。Muse の cron `dsh-bot-autorecover` を 10 分ごとに登録済み（RECOVERING / RESTARTING / error / 0 以外の
終了のときだけ報告）。

## 依頼文 2b（名義と自動復旧の cron。ボットはまだ起動しない）

```text
<@U0CCCH69XMW> DSH ボットの続きです。check の結果ありがとうございました。今回もボットは起動しません（start は実行しないでください）。VM が作り直されて /etc のサービスが消えても、DSH ボットが自分で戻れるようにする準備です。

1. 更新（いつものプロキシの入ったシェルで）
   cd ~/dsh-slack-channel && git pull --ff-only
2. ボットのコミットの名義（~/.gitconfig は変えません）
   ~/dsh-slack-channel/deploy/linux/setup.sh git-identity "azumag" azumag@users.noreply.github.com
3. サービスのプロキシ設定を /etc/environment のもの（通るとき）に書き直して確かめる（値は出ません。ボットは起動していないので再起動もしません。check はモデルの確認で 1〜3 分かかります）
   ~/dsh-slack-channel/deploy/linux/setup.sh net-refresh
   ~/dsh-slack-channel/deploy/linux/setup.sh netcheck
   ~/dsh-slack-channel/deploy/linux/setup.sh check
4. 手で 1 回試す。まだ起動の合図前なので「start-saved: not wanted … nothing to do」で終わるはずです（終了コード 0）
   ~/dsh-slack-channel/deploy/linux/setup.sh start-saved; echo "exit=$?"
5. あなたの cron に 10 分ごとのジョブを登録してください（名前の例: dsh-bot-autorecover。claude-bot-autorecover と同じ形）
   ~/dsh-slack-channel/deploy/linux/setup.sh start-saved
   報告は、出力に RECOVERING / RESTARTING / error が出たとき、または終了コードが 0 以外のときだけにしてください。「nothing to do」のときは何も言わなくて大丈夫です。

返信してほしいもの: git pull の最後の 1 行 / git-identity・net-refresh・netcheck・check・start-saved の出力 / 登録した cron の名前と間隔。
```

3. は、Muse の cron のシェルの認証情報が数分で断られる件の確認。`net-refresh` の出力が `network settings taken from
/etc/environment` なら、サービスは認証情報の入っていない /etc/environment の設定を使う。`netcheck` の `etc-environment https_proxy → …: CONNECT 200`
と、`check` の全項目 ✓ で、その設定で DSH が Slack・モデル・Web 検索に届くことが分かる。

ボットを起動する前に cron を入れても、`~/.dsh-slack/wanted` が無い間は何もしない。`start --cutover` の後は、VM が作り直されても
10 分ほどで戻る。`stop`（ロールバック）で `wanted` が消えると、また何もしなくなる。

### bubblewrap を入れる（`✗ command sandbox` のときだけ。VM のシステムパッケージなので owner の OK を取ってから）

Landlock はカーネル次第（無効なカーネルや、seccomp で止めるコンテナがある）。bubblewrap は Ubuntu の標準パッケージ。
**注意:** Muse の VM は再プロビジョンで `/home/hatch` 以外が作り直される（2026-10-25 に判明）ので、apt で入れた bubblewrap も
消える。Landlock が ✓ ならこの節は不要。

```text
<@U0CCCH69XMW> DSH のボットがコマンドを実行するのにサンドボックス（bubblewrap）が要ります。owner の了承済みです。プロキシの環境変数が入ったシェルで、次を実行してください（root でなければ sudo -E を付けて）。

apt-get update && apt-get install -y bubblewrap
~/dsh-slack-channel/deploy/linux/setup.sh check --no-model

apt の最後の 5 行と、check の出力をそのまま返信してください。
```

## 切り替え（owner の OK が出てから）

### 受付だけ先に VM へ移す（owner の希望、2026-10-25）

Mac の DSH は止めずに、**新しい Slack の受付だけ** VM に移す。Mac で動いているターンと、Mac の待ち行列にある依頼は
Mac で最後まで処理して返信する（返信は Web API なので、ソケットが無くても出せる）。片付いたら Mac の Slack チャンネルを止める。
仕組みは Slack チャンネルの「受付停止ファイル」（`~/.dsh/slack-state.receive-off`。README の「Handing the bot over」）:
このファイルがある間、チャンネルは Slack のソケットを閉じたまま動き続け、残りを `~/.dsh/slack-state.drain.json` に書く。
ファイルを置くだけでプラグインの再読み込みは起きない（dsh-hmr が見ているのは `src/` だけ。チャンネル自身が書く
`slack-state.json` も再読み込みを起こしていない）。

1. **Mac: 受付停止に対応したコードを入れる（1 回だけ再読み込みが起きる）。** `src/` が変わるので dsh-hmr がチャンネルを
   読み直し、そのとき動いているターンは中断される。中断されたターンと待ち行列は pending ファイルに保存され、読み直し後に
   同じセッションで再開する（2026-10-24 に実機で確認済みの仕組み）。owner の OK を取ってから。
2. **Muse: 依頼文 3（下）で VM のボットを起動する。** Mac もまだつながっているので、出力は `socket connected (num_connections=2)`
   になるはず。この間（次の 3. まで）は、新しいイベントが Mac と VM に振り分けられる（どちらかが必ず受けるので、取りこぼしはない）。
3. **Mac: すぐに受付を止める。** `touch ~/.dsh/slack-state.receive-off`。5 秒以内に Mac のソケットが閉じ、
   `~/.dsh/slack-state.drain.json` ができる。DSH のホストプロセスに `wss-primary.slack.com` への接続が無いことでも確かめる。
4. **Mac の残りが片付くのを待つ。** `cat ~/.dsh/slack-state.drain.json` の `running`（実行中）と `waiting`（待ち行列）が空になり、
   `"drained": true` になったら終わり。この間に Mac のターンが承認や質問を出すと、ボタンを押しても VM に届くので、
   Mac 側ですぐに断る（エージェントには「引き継ぎ中で答えられない」と返る）。
5. **Mac: Slack チャンネルを止める**（下の「Mac: Slack チャンネルを止める」。もう何も動いていないので中断は起きない）。
   止めたあとで `rm ~/.dsh/slack-state.receive-off ~/.dsh/slack-state.drain.json`（残しておくと、ロールバックで Mac の
   チャンネルを戻したときに受付停止のまま上がる）。

注意:
- Mac でターンが動いているスレッドに新しく返信が来ると、それは VM が受ける。VM はそのスレッドの直近の発言を文脈に新しい
  セッションで答えるので、Mac と VM の両方が同じスレッドに返信することがある。
- Mac のスケジュール（`~/.dsh/storages/schedule.json`）は、Mac のチャンネルを止めるまでは Mac で動き、返信も Mac から出る。
- 3. の途中で戻すとき: VM で `setup.sh stop`、Mac で `rm ~/.dsh/slack-state.receive-off`（5 秒以内に Mac がまた受け付ける。
  再読み込みは起きない）。

**実施記録（2026-10-25、owner の OK）:** 02:47:35 JST に Mac へ受付停止のコードを入れた（再読み込み 1 回。動いていたターン
1 件はすぐ同じセッションで再開、待ち会話 28 件はそのまま待ち行列に戻った）。02:54:33 に VM が起動（Muse の報告:
`own identity resolved (… user_id=U0C9C7BNVB5)`、`socket connected (num_connections=2)`、プロキシは /etc/environment のもの）。
02:55:13 に Mac で `touch ~/.dsh/slack-state.receive-off` → 02:55:26 までに Mac の DSH から Slack（wss-primary）への接続が消え、
drain.json は running 1 件・waiting 28 件。owner の判断で、28 件は時間がかかっても Mac で最後まで処理する。
~02:57 owner が DSH にメンションして返事を確認（その時点でも Mac に Slack への接続は無く、drain.json も変わらず → 返事は VM から）。

### Mac: Slack チャンネルを止める

Mac の DSH はデスクトップアプリのまま残し、Slack チャンネルだけ止める。`~/.dsh/cordis.patch.yml` の slack-channel 行の
`disabled:` を `true` にする（保存すると dsh-hmr が Slack チャンネルを読み直して切断する。**動いているターンは中断される**ので、
owner の OK を取ってから）。切れたことは、DSH のホストプロセス（`--expose-internals`）に `wss-primary.slack.com` への
接続が無いことで確かめる（`users.getPresence` の `connection_count` は Socket Mode を数えないので使えない）。

Mac で有効なスケジュール（`~/.dsh/storages/schedule.json`）は、DSH アプリが開いている限り Mac で動き続ける。返答は Slack に
出ないが、ツール（gh など）は実行する。止めるかどうかも切り替え時に決める。

### 依頼文 3（起動）

```text
<@U0CCCH69XMW> DSH ボットを VM に切り替えます。VM のボットを起動してください（いつものプロキシの入ったシェルで）。Mac 側の DSH は、VM の起動を確かめたらすぐに新しい受付を止めます（動いている作業は Mac で片付けます）。

cd ~/dsh-slack-channel && git pull --ff-only
~/dsh-slack-channel/deploy/linux/setup.sh install
~/dsh-slack-channel/deploy/linux/setup.sh start --cutover
~/dsh-slack-channel/deploy/linux/setup.sh status

install の最後の 10 行と、start --cutover・status の出力を返信してください。
```

`install` は、VM が作り直されて消えたサービスを書き直し、プロキシ設定を写し直す（/etc/environment のものが通ればそれ。
設定・秘密・入れた DSH・git の名義はそのまま）。Claude ボットの切り替えでは、サービスが消えていて最初の `start --cutover` が失敗した。

`start --cutover` の出力に `own identity resolved (bot_id=…, user_id=U0C9C7BNVB5)` が出れば Slack の Web API まで届いている。
`socket connected (num_connections=N)` は Slack が Socket Mode の接続を受け付けた印で、N はこの Slack アプリへの接続数
（Mac 側が切れていれば 1。受付だけ先に移す手順では、Mac がまだつながっているので 2）。`socket connect failed` / `apps.connections.open failed` が出たら失敗。そのあと Slack で DSH に
メンションして、返事が来るか見る。

### 戻すとき（ロールバック）

1. Muse に `~/dsh-slack-channel/deploy/linux/setup.sh stop`（サービスを止めて、`wanted` を消す。cron の `start-saved` も
   これ以降は何もしない）
2. Mac の `~/.dsh/cordis.patch.yml` の slack-channel 行の `disabled:` を元の式
   `!!js "ctx.get('profileContext') !== undefined && ctx.get('profileContext').name !== 'desktop'"` に戻す（HMR で再接続）

## 更新: 承認プロンプトにコマンドを出す（2026-10-26。VM に入れるのは owner の OK を取ってから）

VM の DSH は bash のコマンドを Landlock のサンドボックスで動かし、外で動かしたいときは Slack に承認プロンプト
（`Approval required — bash`）を出す。DSH の承認リクエストにはツール名・呼び出し id・モデルが書いた理由しか入っていないので、
これまでのプロンプトには理由しか出ず、10-26 に owner はどのコマンドかを見ないまま Allow once を 3 回押した。
ブランチ `approval-command` の変更で、プロンプトに実行されるコマンドがコードブロックで出る:

- チャンネルが `tools/pre-execute` で各呼び出しの引数を覚え（エージェントごとに直近 32 件）、承認リクエストの呼び出し id で引く。
  bash ならコマンド（と `workdir`）、ほかのツールなら引数の JSON（`description` / `justification` は除く）。
- `&` `<` `>` はほかの文字列と同じエスケープ（Slack の書式の決まりでは、コードの中でも元の文字に戻して見せる。本物での見た目は下の「未確認」）。コマンドの中の ```` ``` ```` は
  ブロックを閉じないよう崩す。表示は 2000 文字（エスケープ後）まで。切ったときは本当の長さを添える。
- 秘密らしい値は Slack に出す前に伏せる（`src/redact.js`。`ghp_` `xoxb-` `nvapi-` `sk-` などの形、`*TOKEN*=` `--password`
  `Authorization:` の値、URL の `user:password@`、PEM の秘密鍵）。`$GH_TOKEN` のような参照はそのまま見せる。理由の行にも同じものをかける。
- 決まったあとのメッセージ（✅ Allowed once など）にもコマンドを残す。チャンネルが見ていない呼び出し（再読み込みの直前に出たもの
  など）は「コマンドを表示できない」と出る。

確認済み: 単体テスト 186/186。コンテナ試験（103/103）で、偽のモデルが `GH_TOKEN=<鍵> sh -c '…' 2>&1 < /dev/null` を
`sandbox_permissions: danger-full-access` で呼び、プロンプトにエスケープ済み・鍵を伏せたコマンドが出ること、Slack へ送った
どの呼び出しにも鍵が無いこと、Allow のクリックで実行されて、決まったあとのメッセージにもコマンドが残ることを見た（下の「コンテナでの確認」）。
未確認: 本物の Slack での見た目（コードブロック内の `&lt;` が `<` に見えるか）は、VM に入れたあとの最初の承認プロンプトで見る。

### Mac: master に入れて push する（owner の OK の後）

**2026-10-26 済み（owner「進めて」）:** `dd196ce..5205aa9` を早送りで master に push。Mac のチェックアウト（`~/work/dsh-slack-channel`）は
dd196ce のまま（DSH ホストの dsh-hmr が `src/` を開いていて、無効な行のプラグインで再読み込みがどう動くかは未確認のため触っていない）。

Mac の `~/work/dsh-slack-channel` では `src/` を書き換えない（Mac の DSH の dsh-hmr が見ている）。push はブランチをそのまま送るだけで、作業ツリーのファイルは変わらない:

```sh
cd ~/work/dsh-slack-channel && git push origin approval-command:master
```

（master が `approval-command` の親のままなら早送りで入る。Mac のチェックアウトの master は古いままになるので、あとで
DSH の Slack チャンネルが無効のまま・動いていないときに `git merge --ff-only origin/master`。）

### 依頼文 4（更新して再起動）

```text
<@U0CCCH69XMW> DSH ボットの更新をお願いします。DSH が Slack に出す承認プロンプト（Approval required — bash）に、実際に実行されるコマンドがコードブロックで出るようになります（トークンらしい値は伏せ字になります）。再起動すると、動いている DSH のターンは中断されて再起動後にキューへ戻り、承認待ちのプロンプトがあれば取り消されます。

1. 更新（いつものプロキシの入ったシェルで）
   cd ~/dsh-slack-channel && git pull --ff-only && git log --oneline -1
2. 再起動して、1 分ほど待ってから状態を見る（restart は再起動したことしか出しません）
   ~/dsh-slack-channel/deploy/linux/setup.sh restart
   sleep 60; ~/dsh-slack-channel/deploy/linux/setup.sh status

返信してほしいもの: git log の 1 行 / restart と status の出力（status に socket connected が出ているか）。
```

`git log` の 1 行が push したコミットで始まり、`status` に `socket connected` が出れば入っている。そのあと DSH が承認プロンプトを
出したら、`*Command*` の下にコードブロックでコマンドが出ているかを Slack で見る。戻すときは、ワークツリーでこのコミットを
`git revert` して master に push し、同じ依頼文をもう一度送る（VM の作業ツリーを手で別のコミットにしない。次の `git pull --ff-only` が通らなくなる）。

## 更新: Pi をチームから外して Cursor を入れる（2026-10-27、owner の決定）

owner: 「Pi はチームから外す。各ボットの名簿と受け付けリストの Pi を Cursor に置き換えて。Pi のボット自体はまだ止めない。」
Cursor は Muse の VM の新しいボット（`cursor`、U0CCEFW46SD、実装担当）。DSH では次の 2 か所が Pi だった:

- `mentionUserIds`（DSH が本文で本当にメンションしてよい相手）の `- U0CA79CM3FF   # pi`
- `surfacePrompt` の名簿の implementers の `Pi <@U0CA79CM3FF>`

テンプレート（`deploy/linux/templates/slack-channel.patch.yml`）は直した。VM で動いているのはテンプレートから書き出した
`~/.dsh-slack/slack-channel.patch.yml`（`install` は既にあるファイルを残す）なので、依頼文 5 でその 2 か所だけを置き換える。

**受け付けについて:** DSH には送り手を絞る設定が無い。許可されたチャンネル（VM は `allowAllChannels: true`）で DSH に
メンションすれば、人でもどのボットでもターンが始まる（ボット同士の往復は `maxBotTurns` / `maxBotRepeats` で止まるだけ）。
置き換える「受け付けリスト」が無いので、Cursor はもう受け付けられていて、Pi のメンションもまだ DSH のターンを始める。
止めるには送り手を無視する設定をコードに足す必要がある（owner の判断で今は足さない、2026-10-27）。

依頼文 5 は依頼文 4（コードの更新）を含む。依頼文 4 を送った後でも害はない（`git pull` が Already up to date になるだけ）。
2. と 3. の長い行は、長さと sha256 の先頭 16 桁が合ったときだけ動く（10-27 に Muse が長い文字列を手で打ち直して壊したため）。
2. は置き換える前に元のファイルを `.bak-before-cursor-<日時>` に写し、Pi の行が 2 つ・Cursor が 0 のときだけ、
別ファイルに書いてから入れ替える（Pi 0・Cursor 2・差分 4 行を確かめる）。2 回目は STOP で何もしない。
3. は直近 40 分に書かれたセッションログ（`~/.dsh-slack/home/sessions/*/*/session.v4.jsonl.zstd`）で、`turn/start` より
`turn/end` が少ないもの、答えの出ていない `approval/asked` があるものを数える（キットの Node の zstd で読む。書きかけの
最後のフレームは読み飛ばす）。

確認済み（Mac、2026-10-27）: VM に似せたコンテナ（dshslack-test:base、GNU sed、Node v24.22.1）で 15/15 — 置き換え後の
ファイルが新しいテンプレートを同じ手順で書き出したものとバイト単位で一致、mode 600、バックアップ = 元、2 回目は STOP、1 文字
変えたコマンドは STOP で何も動かない。3. はセッション無し → IDLE、終わったターンと 2 時間前の中断 → IDLE、書きかけのターン →
BUSY（終了コード 1）、承認待ち → BUSY、承認後に終わった → IDLE。Mac の実ログでも、書き込み中のデスクトップのターンを BUSY と出した。
置き換え前後の YAML は ruby の YAML で読めた。未確認: VM の実ファイルが同じ形か（2. のガードが確かめる）、本物の DSH が新しい設定で上がるか（4. の status で見る）。

戻すとき: `cp -p ~/.dsh-slack/slack-channel.patch.yml.bak-before-cursor-<日時> ~/.dsh-slack/slack-channel.patch.yml` →
`setup.sh restart`。テンプレートの変更を master に入れないまま `install --reconfigure` すると Pi に戻る。

### 依頼文 5（コードの更新 + Pi を Cursor に置き換え + 再起動）

```text
<@U0CCCH69XMW> DSH ボットの更新をお願いします。2 つあります。(a) 承認プロンプト（Approval required — bash）に、実際に実行されるコマンドがコードブロックで出るようになるコードの更新。(b) チームから Pi が外れて Cursor が入ったので、DSH の設定（~/.dsh-slack/slack-channel.patch.yml）の名簿と「メンションしてよい相手」の Pi を Cursor（U0CCEFW46SD）に置き換えます。最後に 1 回だけ再起動します。再起動すると動いている DSH のターンが中断されるので、先に動いていないことを確かめます。2. と 3. の長い行はそのまま貼ってください（長さと sha256 を確かめてから動き、合わなければ STOP と出て何もしません）。

1. コードの更新（いつものプロキシの入ったシェルで。更新済みなら Already up to date と出ます）
   cd ~/dsh-slack-channel && git pull --ff-only && git log --oneline -1
2. 設定の Pi を Cursor に置き換える（元のファイルは .bak-before-cursor-<日時> に残ります。STOP と出たら 3. 以降に進まずに返信してください）
   C='F=$HOME/.dsh-slack/slack-channel.patch.yml; p=$(grep -c U0CA79CM3FF "$F"); c=$(grep -c U0CCEFW46SD "$F"); if [ "$p" = 2 ] && [ "$c" = 0 ]; then B="$F.bak-before-cursor-$(date +%Y%m%d-%H%M%S)"; cp -p "$F" "$B" && sed -e "s/- U0CA79CM3FF   # pi$/- U0CCEFW46SD   # cursor/" -e "s/Pi <@U0CA79CM3FF>/Cursor <@U0CCEFW46SD>/" "$F" > "$F.new" && [ "$(grep -c U0CA79CM3FF "$F.new")" = 0 ] && [ "$(grep -c U0CCEFW46SD "$F.new")" = 2 ] && [ "$(diff "$F" "$F.new" | grep -c "^[<>]")" = 4 ] && chmod 600 "$F.new" && mv "$F.new" "$F" && echo "EDITED: Pi -> Cursor on 2 lines; backup $B" || { rm -f "$F.new"; echo "STOP: the edit did not come out as expected; $F is unchanged (backup $B)"; }; else echo "STOP: expected 2 Pi lines and 0 Cursor lines, found pi=$p cursor=$c; nothing changed"; fi'; if [ ${#C} = 778 ] && [ "$(printf %s "$C" | sha256sum | cut -c1-16)" = d19b54ddf2368560 ]; then eval "$C"; else echo "STOP: the command was changed in copying (length ${#C}); nothing ran"; fi
3. DSH のターンが動いていないか確かめる（IDLE なら 4. へ。BUSY なら 5 分待ってもう一度。30 分たっても BUSY なら、再起動せずにここまでの出力を返信してください）
   N=$(grep -m1 ^DSK_NODE= ~/.dsh-slack/env | cut -d= -f2-); J='const fs=require("fs"),p=require("path"),z=require("zlib"),root=process.env.HOME+"/.dsh-slack/home/sessions",win=40*60e3;let busy=0,seen=0;const ls=(d)=>{try{return fs.readdirSync(d)}catch{return []}};for(const d of ls(root))for(const s of ls(p.join(root,d))){const f=p.join(root,d,s,"session.v4.jsonl.zstd");let st;try{st=fs.statSync(f)}catch{continue}if(Date.now()-st.mtimeMs>win)continue;seen++;let a=0,b=0,q=0;for(const l of z.zstdDecompressSync(fs.readFileSync(f),{finishFlush:z.constants.ZSTD_e_flush}).toString().split("\n")){let t;try{t=JSON.parse(l).type}catch{continue}if(t==="turn/start")a++;if(t==="turn/end")b++;if(t==="approval/asked")q++;if(t==="approval/decided")q--}if(a>b||q>0){busy++;console.log("RUNNING "+s+" turns "+a+"/"+b+" prompts "+q+" last write "+new Date(st.mtimeMs).toISOString())}}console.log(busy?"BUSY: "+busy+" session(s) mid-turn - do not restart yet":"IDLE: no turn running ("+seen+" session(s) written in the last 40 min)");process.exit(busy?1:0)'; if [ ${#J} = 983 ] && [ "$(printf %s "$J" | sha256sum | cut -c1-16)" = 1ae11de4111b2b5d ]; then "${N:-$HOME/.dsh-slack/node/bin/node}" -e "$J"; else echo "STOP: the command was changed in copying (length ${#J}); nothing ran"; fi
4. 再起動して、1 分ほど待ってから状態を見る
   ~/dsh-slack-channel/deploy/linux/setup.sh restart
   sleep 60; ~/dsh-slack-channel/deploy/linux/setup.sh status

返信してほしいもの: 1. の git log の 1 行 / 2. の EDITED か STOP の行 / 3. の IDLE か BUSY の行 / restart と status の出力（status に socket connected が出ているか）。
```

## VM のファイル

| パス | 中身 |
|---|---|
| `~/dsh-slack-channel` | このリポジトリ（Slack チャンネルのコード + キット） |
| `~/.dsh-slack/env` | サービスの環境（HOME、PATH、DSH_HOME、プロキシ変数、ボットの git 名義）。600。`install` が書き直す（git の名義は残す）ので、手で足す行は `~/.dsh-slack/env.local` に書く |
| `~/.dsh-slack/wanted` | `start --cutover` が作り、`stop` が消す。`start-saved` はこれがあるときだけ動く |
| `~/.dsh-slack/logs/start-saved.history` | `start-saved` が起動・再起動したときの記録（UTC） |
| `~/.dsh-slack/home/` | DSH のホーム: `cordis.patch.yml`（モデルのプロバイダ、Web 検索、GitHub MCP）、`profiles/slack/`、`.env`（API キー）、`sessions/`、`slack-state.json` |
| `~/.dsh-slack/slack-channel.patch.yml` | Slack チャンネルの設定（サービスだけが `--patch` で読む。秘密は入っていない） |
| `~/.dsh-slack/secrets/slack.json` | Slack トークン。600 |
| `~/.dsh-slack/check-home/` | `check` の headless 実行用の DSH ホーム（設定とキーはリンク） |
| `~/.dsh-slack/logs/dsh.log` | DSH のログ（`setup.sh logs`。DSH の Web 画面のトークンは伏せて表示） |
| `/etc/systemd/system/dsh-slack.service` | サービス（root で動く VM の場合。`systemctl --user` の場合は `~/.config/systemd/user/`）。VM が作り直されると消える → `start-saved` が書き直す |

更新は `cd ~/dsh-slack-channel && git pull --ff-only` → `setup.sh restart`（動いているターンは中断され、再起動後にキューへ戻る）。
テンプレートを変えたときは `setup.sh install --reconfigure`（古い設定は `.bak-*` で残る）。

## コンテナでの確認（Mac で）

`deploy/linux/test/run.sh` が、VM に似せた Ubuntu 24.04（x86_64、systemd、root で `HOME=/home/hatch`、外へは HTTP プロキシ経由だけ、
直接の :443 は平文の箱に当たる）で、clone → install → keygen → seal/import → check → `start --cutover` → 偽の Slack のメンションに
サンドボックスの外で動かす bash の承認プロンプト（コマンドが出て鍵が伏せてあるか見て、Allow をクリック）、bash ツール、web_search を使って返答 → restart → `start-saved`（サービスが消えた VM をプロキシ無し・有りのシェルから戻す、
env ファイルのプロキシが 407 を返す、ソケットが失敗し続ける）→ stop を通す。bash ツールのサンドボックスは bubblewrap（OrbStack のカーネルには Landlock が
無い）。最初の `check` だけ `bwrap` を隠して、`check` がサンドボックスの無いホストを `✗` にすることも見る。Slack・モデル API・GitHub MCP はすべて偽物（`fake-world.mjs`）。
