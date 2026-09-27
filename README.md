# @bash0816/opencode-termux

[OpenCode](https://opencode.ai/) CLI for Termux on Android ARM64.

Termux 向け OpenCode CLI wrapper package です。

> **This project is not affiliated with, endorsed by, or sponsored by SST / the OpenCode project.**
> このプロジェクトは OpenCode プロジェクト（SST）と無関係です。公式から承認・提携・保証されたものではありません。

OpenCode is released under the [MIT License](https://github.com/anomalyco/opencode/blob/main/LICENSE).
This wrapper simply downloads the official upstream binary and adjusts it to run on Termux/Android; it does not modify OpenCode's own functionality.

OpenCode 本体は [MIT ライセンス](https://github.com/anomalyco/opencode/blob/main/LICENSE) で公開されています。
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

## Prerequisites / 前提条件

```sh
pkg install glibc-repo && pkg install glibc
pkg install patchelf
```

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

This package downloads the specific verified upstream version pinned in
`config/opencode-verified-versions.json`.

このパッケージは `config/opencode-verified-versions.json` に固定された検証済み
upstream バージョンをダウンロードします。

## Usage / 使い方

```sh
opencode [command] [options]
opencode run "your prompt here"
```

For available commands, see the [OpenCode documentation](https://opencode.ai/docs/).

利用可能なコマンドは [OpenCode ドキュメント](https://opencode.ai/docs/) を参照してください。

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

If a critical issue is discovered after promoting a new version to `latest`, you can
immediately roll back to the previous version using the following command:

新バージョン昇格後に重大な問題が発見された場合、以下のコマンドで前バージョンに
ロールバックできます:

```sh
npm dist-tag add @bash0816/opencode-termux@<previous known-good version> latest
```

This reverts the `latest` tag to a previous known-good version and will restore the
previous stable release for all new installations and updates.

これにより `latest` タグを前のステーブル版に戻し、新規インストール・更新時に前の
ステーブル版を配布します。
