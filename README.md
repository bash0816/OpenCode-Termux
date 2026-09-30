# @bash0816/opencode-termux

[OpenCode](https://opencode.ai/) CLI for Termux on Android ARM64.

Termux 向け OpenCode CLI wrapper package です。

> **This project is not affiliated with, endorsed by, or sponsored by SST / the OpenCode project.**
> このプロジェクトは OpenCode プロジェクト（SST）と無関係です。公式から承認・提携・保証されたものではありません。

OpenCode is released under the [MIT License](https://github.com/anomalyco/opencode/blob/dev/LICENSE).
This wrapper simply downloads the official upstream binary and adjusts it to run on Termux/Android; it does not modify OpenCode's own functionality.

OpenCode 本体は [MIT ライセンス](https://github.com/anomalyco/opencode/blob/dev/LICENSE) で公開されています。
本ラッパーは公式 upstream バイナリをダウンロードし、Termux/Android 上で動作するよう調整するのみで、OpenCode 自体の機能を変更するものではありません。

## What this does / 仕組み

This package downloads the official OpenCode CLI binary from npm
([`@opencode/cli-linux-arm64`](https://www.npmjs.com/package/@opencode/cli-linux-arm64))
at the user's explicit request, then rewrites the binary's ELF interpreter (using
[`patchelf`](https://github.com/NixOS/patchelf)) so it can be executed directly on
Termux/Android using a glibc runtime, instead of Android's default bionic libc.

このパッケージはユーザーの明示的な操作により、npm から OpenCode CLI の公式バイナリ
([`@opencode/cli-linux-arm64`](https://www.npmjs.com/package/@opencode/cli-linux-arm64))
をダウンロードし、[`patchelf`](https://github.com/NixOS/patchelf) を使って ELF
インタープリタを書き換えることで、Android 標準の bionic libc ではなく glibc ランタイム上で
直接実行できるようにします。

- **No OpenCode binaries or modified binaries are distributed by this package.**
- **このパッケージは OpenCode バイナリや改変済みバイナリを配布しません。**
- The rewrite is intended solely for Termux/Android runtime interoperability.
  It does not bypass authentication, licensing, payment, access controls, or usage restrictions.
- 書き換えの目的は Termux/Android 実行環境への互換性確保のみです。
  認証・ライセンス・課金・アクセス制御・利用制限の回避を意図するものではありません。

## OpenCode 1.x and 2.x / OpenCode の 1系と2系

OpenCode has two separate npm distribution lines: 1.x (`opencode-ai`) and 2.x.
The official npm package for 2.x is [`@opencode/cli`](https://www.npmjs.com/package/@opencode/cli);
`@opencode/cli-linux-arm64` is its Linux ARM64 binary package. This package supports
only the 2.x line (`@opencode/cli-linux-arm64`), not the 1.x line (`opencode-ai`).
For the official documentation, see [OpenCode 1.x](https://opencode.ai/docs) and
[OpenCode 2.x](https://opencode.ai/v2/docs).

OpenCode には npm 上で別系統の配布ラインが 2 つあります。1系は `opencode-ai`、
2系の公式 npm パッケージは [`@opencode/cli`](https://www.npmjs.com/package/@opencode/cli) です。
`@opencode/cli-linux-arm64` はその Linux ARM64 用バイナリパッケージです。
本パッケージが対応するのは2系 (`@opencode/cli-linux-arm64`) のみで、1系
(`opencode-ai`) には対応していません。公式ドキュメントは[1系](https://opencode.ai/docs)、
[2系](https://opencode.ai/v2/docs)を参照してください。

## Prerequisites / 前提条件

```sh
pkg install glibc-repo && pkg install glibc
pkg install patchelf
pkg install llvm
```

readelf は llvm パッケージが提供します / readelf is provided by the llvm package

## Install / インストール

```sh
npm install -g @bash0816/opencode-termux
```

On first run, the official OpenCode binary will be downloaded from npm and patched
for this device. Subsequent runs reuse the cached, verified installation.

初回起動時に npm から公式 OpenCode バイナリがダウンロードされ、このデバイス向けに
パッチが適用されます。以降の起動ではキャッシュ済みの検証済みインストールを再利用します。

**Tested with OpenCode 2.0.18 on Termux/Android ARM64.**

**OpenCode 2.0.18・Termux/Android ARM64 で動作確認済み。**

## Update / 更新

```sh
npm update -g @bash0816/opencode-termux
```

This package's `package.json` version is the corresponding upstream
`@opencode/cli-linux-arm64` version, which is fetched from npm.

本パッケージの `package.json` の version が対応する upstream
`@opencode/cli-linux-arm64` のバージョンであり、そのバージョンを npm から取得します。

## Authentication / 認証

Before using OpenCode, log in to a provider. Requirements such as billing information,
credits, and API keys vary by provider; see the official
[Console instructions](https://opencode.ai/v2/docs/console/models/):

OpenCode を使う前に、プロバイダへログインしてください。請求情報・クレジット・APIキー等の
必要な手順はプロバイダごとに異なるため、公式の
[Console 手順](https://opencode.ai/v2/docs/console/models/)を参照してください:

```sh
opencode auth login opencode
```

This starts the login process. Follow the on-screen instructions to complete it.
Run `opencode auth list` to check saved authentication. For details, see
`opencode auth login --help`.

`opencode auth login opencode` でログインを開始し、画面の案内に従って完了してください。
保存済み認証は `opencode auth list` で確認できます。詳細は
`opencode auth login --help` を参照してください。

To use a different provider (Anthropic, OpenAI, etc.), see
`opencode auth login --help` and the
[OpenCode provider documentation](https://opencode.ai/v2/docs/providers).

他のプロバイダ（Anthropic・OpenAI 等）を使う場合は `opencode auth login --help` と
[OpenCode プロバイダ ドキュメント](https://opencode.ai/v2/docs/providers) を参照してください。

## Usage / 使い方

```sh
opencode [command] [options]
opencode run "your prompt here"
opencode run --model opencode/<model-id> "your prompt here"
```

Run `opencode models` to list available models. Availability and requirements vary
by provider; see the official [Console instructions](https://opencode.ai/v2/docs/console/models/).

利用可能なモデル一覧は `opencode models` で確認できます。提供状況や利用条件は
プロバイダごとに異なるため、公式の[Console 手順](https://opencode.ai/v2/docs/console/models/)を参照してください。

For available commands, see the [OpenCode documentation](https://opencode.ai/v2/docs/cli/commands).

利用可能なコマンドは [OpenCode ドキュメント](https://opencode.ai/v2/docs/cli/commands) を参照してください。

## License / ライセンス

This package (`opencode-termux`) is licensed under [GPL-3.0-only](./LICENSE).

このパッケージ (`opencode-termux`) は [GPL-3.0-only](./LICENSE) ライセンスです。

**The GPL does not apply to the OpenCode binary itself.** The OpenCode binary
downloaded at runtime is released by its authors under the MIT License and is
subject to OpenCode's own terms.

**GPL は OpenCode バイナリ自体には適用されません。** 実行時にダウンロードされる
OpenCode バイナリは、その作者により MIT ライセンスで公開されており、OpenCode
自体の利用条件に従います。

## Disclaimer / 免責事項

Users are responsible for ensuring that their use of OpenCode complies with
OpenCode's [Terms of Service](https://opencode.ai/legal/terms-of-service) and
applicable laws.

OpenCode の利用条件・適用法令への適合性はユーザー自身が確認してください。
[OpenCode 利用規約](https://opencode.ai/legal/terms-of-service) を参照してください。

If a rights holder or platform operator raises a substantiated concern regarding
this package, we will promptly review it and may remove or disable the affected
functionality.

権利者またはプラットフォーム運営者から具体的な懸念が示された場合、
内容を確認し、必要に応じて公開停止・機能停止・修正を行います。

## Compatibility / 動作環境

- **Platform / プラットフォーム**: Android (Termux)
- **Architecture / アーキテクチャ**: ARM64 (aarch64)
- **Monitored upstream package / 監視対象パッケージ**: `@opencode/cli-linux-arm64`
  (v2 series). Not to be confused with the separate `opencode-ai` npm package (v1 series).
  `opencode-ai`（v1系列）という別系統のnpmパッケージとは異なりますのでご注意ください。

## Known limitations / 既知の制限

- Upstream OpenCode updates may require a compatibility update to this package.
  上流 OpenCode のアップデートにより本パッケージの更新が必要になる場合があります。
- If the downloaded binary fails verification, the tool will exit safely.
  ダウンロードしたバイナリが検証に失敗した場合、安全に終了します。
- This package does not currently provide an automatic cleanup command for old
  cached installs under `~/.opencode-termux/installs/`; old versions may need to
  be removed manually to reclaim disk space.
  `~/.opencode-termux/installs/` 配下の古いキャッシュ済みインストールを自動削除する
  コマンドは現時点で提供していません。ディスク容量が必要な場合は手動で削除してください
  （他の OpenCode セッションが実行中でないことを確認の上で）。

## Rollback / ロールバック手順

**(For package maintainers / パッケージ管理者向けの手順です)**

If a critical issue is discovered after promoting a new version to `latest`, you can
immediately roll back to the previous version using the following command:

新バージョン昇格後に重大な問題が発見された場合、以下のコマンドで前バージョンに
ロールバックできます:

```sh
npm dist-tag add @bash0816/opencode-termux@<previous known-good version> latest
```

This moves the `latest` tag to a previous known-good version. The change applies to
subsequent new installations and updates.

これにより `latest` タグが指す版が変わり、以降の新規インストール・更新に反映されます。
