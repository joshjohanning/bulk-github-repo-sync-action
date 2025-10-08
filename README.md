# bulk-github-repo-sync-action

[![CI](https://github.com/joshjohanning/bulk-github-repo-sync-action/actions/workflows/ci.yml/badge.svg)](https://github.com/joshjohanning/bulk-github-repo-sync-action/actions/workflows/ci.yml)
[![Publish GitHub Action](https://github.com/joshjohanning/bulk-github-repo-sync-action/actions/workflows/publish.yml/badge.svg)](https://github.com/joshjohanning/bulk-github-repo-sync-action/actions/workflows/publish.yml)
![Coverage](./badges/coverage.svg)

🔄 Sync GitHub repositories from source to target organizations using mirror cloning. Creates target repositories if they don't exist, with support for visibility control, Actions disabling, and archiving.

## Features

- 🔄 **Mirror cloning** - Complete repository sync including all branches and tags
- 🏗️ **Automatic repository creation** - Creates target repos if they don't exist
- 👁️ **Visibility control** - Set repository visibility per repo (private/public/internal)
- 🚫 **GitHub Actions management** - Disable Actions on target repositories
- 📦 **Repository archiving** - Archive repositories after sync (with smart unarchive/re-archive)
- 🌐 **Multi-server support** - Sync between GitHub.com and GitHub Enterprise Server
- 📊 **Post-run analysis** - Detailed sync summary with statistics

## Example Usage

> [!TIP]
> This example uses personal access tokens for simplicity. See the [GitHub Apps section](#usage-with-github-apps-recommended) below for the recommended approach using GitHub Apps.

```yml
- uses: actions/checkout@v5
- name: Bulk GitHub Repository Sync
  uses: joshjohanning/bulk-github-repo-sync-action@v1
  with:
    repo-list-file: repos.yml
    source-github-token: ${{ secrets.SOURCE_GITHUB_TOKEN }}
    target-github-token: ${{ secrets.TARGET_GITHUB_TOKEN }}
    overwrite-repo-visibility: true # overwrite repo visibility with what is in yml file; defaults to false
    force-push: false # force push to target repos (overwrites history); defaults to false
    ### only needed if either your source or target is NOT github.com
    # target-github-api-url: https://ghes.domain.com/api/v3 # API URL for GHES
    # source-github-api-url: https://api.github.com # only needed if source is not github.com
```

## Repository List Format

The repository list uses YML format with per-repository configuration:

```yml
repos:
  - source: source-org/source-repo-1
    target: target-org/target-repo-1
    visibility: private # Optional: private, public, or internal (defaults to private)
    disable-github-actions: true # Optional: disable Actions on target repo (defaults to true)
    archive-after-sync: false # Optional: archive repo after sync (defaults to false)
```

### Sample Configuration

See [sample file](./sample-repos-list.yml).

## Usage with GitHub Apps (recommended)

You can use a personal access token, but it is recommended to use GitHub Apps instead:

> [!NOTE]
> **Required GitHub App Permissions:**
>
> - **Source App**: Repository **Read** access to `contents` and `metadata`
> - **Target App**: Repository **Read and Write** access to `actions`, `administration`, `contents`, and `metadata`

```yml
- uses: actions/checkout@v5
# source
- uses: actions/create-github-app-token@v2
  id: source-app-token
  with:
    app-id: ${{ vars.SOURCE_APP_ID }}
    private-key: ${{ secrets.SOURCE_APP_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
# target
- uses: actions/create-github-app-token@v2
  id: target-app-token
  with:
    app-id: ${{ vars.TARGET_APP_ID }}
    private-key: ${{ secrets.TARGET_APP_PRIVATE_KEY }}
    owner: joshjohanning-emu
- name: Bulk GitHub Repository Sync
  uses: joshjohanning/bulk-github-repo-sync-action@v1
  with:
    repo-list-file: repos.yml
    source-github-token: ${{ steps.source-app-token.outputs.token }}
    target-github-token: ${{ steps.target-app-token.outputs.token }}
    overwrite-repo-visibility: true # overwrite repo visibility with what is in yml file; defaults to false
    # force push to target repos (overwrites history); defaults to false
    # target-github-api-url: https://ghes.domain.com/api/v3 # only needed if target is GHES
```

## Configuration Options

### Per-Repository Settings (YML)

| Setting                  | Description                                     | Default   |
| ------------------------ | ----------------------------------------------- | --------- |
| `source`                 | Source repository in `owner/repo` format        | -         |
| `target`                 | Target repository in `owner/repo` format        | -         |
| `visibility`             | Repository visibility (private/public/internal) | `private` |
| `disable-github-actions` | Disable GitHub Actions on target repository     | `true`    |
| `archive-after-sync`     | Archive repository after successful sync        | `false`   |

### Action Inputs

| Input                       | Description                                                                                                               | Required | Default                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| `repo-list-file`            | YML file with repository configurations                                                                                   | Yes      | -                                    |
| `source-github-token`       | GitHub PAT for source repositories                                                                                        | Yes      | -                                    |
| `target-github-token`       | GitHub PAT for target repositories                                                                                        | No       | (uses source token if not specified) |
| `source-github-api-url`     | Source GitHub API URL (e.g., `https://api.github.com` or `https://ghes.domain.com/api/v3`). Instance URL is auto-derived. | No       | `${{ github.api_url }}`              |
| `target-github-api-url`     | Target GitHub API URL (e.g., `https://api.github.com` or `https://ghes.domain.com/api/v3`). Instance URL is auto-derived. | No       | `${{ github.api_url }}`              |
| `overwrite-repo-visibility` | Force update visibility of existing repos                                                                                 | No       | `false`                              |
| `force-push`                | Force push to target repositories (overwrites history)                                                                    | No       | `false`                              |

## Local Command Line Usage

You can also run the script directly:

```bash
export SOURCE_GITHUB_TOKEN=ghp_abc
export TARGET_GITHUB_TOKEN=ghp_xyz
node src/index.js --file=repos.yml
```

## Sample Output

```text
=== SYNC SUMMARY ===
Total repositories: 5
✅ Successful: 5
❌ Failed: 0
🆕 Created: 2
🔄 Updated: 3
👁️  Visibility updated: 1
📦 Archived: 2
```
