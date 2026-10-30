Owner: [`package.json`](../package.json), [CI](../.github/workflows/ci.yml), [publish workflow](../.github/workflows/publish.yml) and [`scripts/check-package.ts`](../scripts/check-package.ts).

# Release

The package is `cortico-world-generals`; the source repository is
[`Lantichr/cortico-world-generals`](https://github.com/Lantichr/cortico-world-generals).
The current candidate is `0.1.0-rc.3`, prepared for the `next` dist-tag. It targets World API 6
and the tested Cortico SDK `0.2.3`. S1 runs on the unmodified host. The included
[pause-hook patch](host-compatibility.md) optionally links global pause to S1; without it,
global pause leaves S1 running. Release notes must retain this operating limit.

## Local checks

Use the pnpm version declared in `package.json`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm check:package
corepack pnpm check:host-patch
npm pack --dry-run
```

`check:package` creates and unpacks a real tarball, then runs the packaged engine against a
local protocol server and reads its viewer and SSE endpoint. It also checks the packaged
`describe.json` against the definition's tools, events and environment prompt. It uses no game account.
`check:host-patch` applies the optional compatibility patch to a temporary copy of the installed
SDK and verifies pause propagation. Keep this check even when the target host does not use the
patch. Neither command changes the installed SDK or a deployment.

After changing tool/event declarations or the environment prompt, regenerate `describe.json`
from the Cortico source host's root with `pnpm describe:extension /path/to/cortico-world-generals`.

The package ships `src/`, `describe.json`, documentation, examples, the host patch and the MIT license. Tests,
development tools, dependencies, account identifiers and deployment data stay out of the tarball.
Review the Git tree and the pack listing before publication. An initial repository should contain
the extension's source history, without importing the parent framework's unrelated history.

Checks require Python 3.10+ and run the packaged city-half-1 subprocess without pip dependencies.
The tarball includes its Python policy, the required Harris source subset and MIT notice, and
the configuration migration under `compat/`. `check:package` tests both S1 backends through
the packaged engine, including an S2 intent, against a loopback protocol server.

## First npm publication

Before publishing, confirm that the npm account can publish `cortico-world-generals`. No registry
ownership is implied by the package name in this repository. Create the public GitHub repository
at the address above and upload the reviewed commit.

For a new npm package, sign in locally and publish the checked candidate:

```sh
npm login
npm publish --access public --tag next
```

This is an external publication step. Local validation and `npm pack` do not publish anything.
After the package exists, configure its npm **Trusted Publisher** for:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository owner | `Lantichr` |
| Repository | `cortico-world-generals` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |

In GitHub, create the `npm` environment and set its required reviewers. The workflow declares
the environment; the review requirement is configured in repository settings. No npm token is
stored by this repository.

## Subsequent releases

Update `package.json` and the lockfile, run the checks and commit the change. Create a GitHub
Release whose tag is exactly `v<package.json version>`, such as `v0.1.0-rc.3`. Publishing the
Release starts `publish.yml`; it checks the version, tests, types, package and host patch before
publishing with npm provenance after environment approval.

`publishConfig.tag` remains `next` for candidates. Set it to `latest` when preparing the stable
release. A version already published on npm cannot be replaced; use a new version for a changed
package. If the first candidate was published locally, its GitHub Release still runs all checks
and skips npm publication when that exact version already exists. Registry errors other than a
missing package or version fail the workflow. A skipped publication does not compare the registry
tarball with the source tree; change the version when the package contents change.

## 中文

`0.1.0-rc.3` 的 S1 可在原版 Cortico 0.2.3 上运行；暂停联动补丁为可选增强，未接入时
全局暂停不会停止 S1。发布说明需保留此限制，`check:host-patch` 仍需通过。

本仓的本地检查不会上传 GitHub 或发布 npm。首次发布前，核对可选宿主补丁、源码树和
`npm pack --dry-run` 清单；确认自己有 npm 包名发布权限后再登录发布候选版。首次建立包后，
按上表配置 npm Trusted Publisher，并在 GitHub 的 `npm` 环境设置 Required reviewers。
后续 GitHub Release 使用与 `package.json` 一致的 `v<版本>` 标签，候选版保留 `next` 标签。
