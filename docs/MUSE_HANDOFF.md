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
    `net-refresh` / `start-saved` 共通）。Muse の cron の実行ごとのシェルの認証情報は数分で断られ（407）、`/etc/environment`
    のもの（VM の起動時に書かれる）は 80 分以上通った（2026-10-25、opencode キットで実測）。シェルのものを写すと、次の cron で
    また写し直す再起動の繰り返しになる（opencode ボットで 10 分ごとに起きた）。
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
`/etc/environment` のものは長く通る（opencode キットでの実測）。DSH のサービスで効くかは VM で未確認。

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
/etc/environment` なら、サービスは VM の起動時に書かれた設定を使う。`netcheck` の `etc-environment https_proxy → …: CONNECT 200`
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
bash ツールと web_search を使って返答 → restart → `start-saved`（サービスが消えた VM をプロキシ無し・有りのシェルから戻す、
env ファイルのプロキシが 407 を返す、ソケットが失敗し続ける）→ stop を通す。bash ツールのサンドボックスは bubblewrap（OrbStack のカーネルには Landlock が
無い）。最初の `check` だけ `bwrap` を隠して、`check` がサンドボックスの無いホストを `✗` にすることも見る。Slack・モデル API・GitHub MCP はすべて偽物（`fake-world.mjs`）。
