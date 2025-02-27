# Diff Split Comments

A GitHub Action that generates and posts split diff comments on Pull Requests. This action is particularly useful when you need to show the differences between all files between two folders.

## Features

- Generates diff between two directories
- Splits large diffs into multiple comments to avoid GitHub's size limitations
- Posts each file's diff as a separate comment for better readability
- Supports ignoring specific file patterns
- Automatically cleans up previous diff comments
- Handles colored diffs for better visualization

## Usage

```yaml
- name: Post diff
  uses: kazysgurskas/diff-action@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    source-dir: /path/to/live/config
    target-dir: /path/to/pr/config
    comment-prefix: "Diff Diff"
    ignore-patterns: "*.md,.gitignore,README.*"
```

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `token` | GitHub token for posting comments | Yes | `${{ github.token }}` |
| `source-dir` | Source directory for comparison (typically from live branch) | Yes | N/A |
| `target-dir` | Target directory for comparison (typically from PR branch) | Yes | N/A |
| `max-comment-size` | Maximum size in characters for each comment | No | `65000` |
| `ignore-patterns` | Comma-separated list of file patterns to ignore | No | `''` |
| `delete-previous-comments` | Whether to delete previous diff comments | No | `true` |
| `comment-prefix` | Prefix to add to each comment title | No | `Diff` |

## Example Workflow

The following example shows how to use this action in a GitOps workflow that compares hydrated Kubernetes manifests:

```yaml
name: GitOps Diff

on:
  pull_request:
    branches: [ main ]

jobs:
  gitops-diff:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout PR branch
        uses: actions/checkout@v3
        with:
          fetch-depth: 0

      # Get a fixed reference point from live branch
      - name: Get fixed live reference
        id: get-live-ref
        uses: actions/github-script@v6
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            // Script to find or create a reference point
            // (see full example in example.yaml)

      - name: Set environment variables
        run: |
          echo "LIVE_HEAD=${{ steps.get-live-ref.outputs.result }}" >> $GITHUB_ENV

      - name: Render Helm charts from PR branch
        run: |
          ./render-helm-charts.sh
          mkdir -p /tmp/pr-output
          cp -r output/* /tmp/pr-output/

      - name: Checkout live at specific commit
        run: |
          git checkout $LIVE_HEAD
          ./render-helm-charts.sh
          mkdir -p /tmp/live-output
          cp -r output/* /tmp/live-output/

      - name: Post GitOps diff
        uses: your-username/gitops-diff-split-comments@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          source-dir: /tmp/live-output
          target-dir: /tmp/pr-output
          comment-prefix: "GitOps Diff"
          ignore-patterns: "*.md,.gitignore,README.*"
```

## Fixed Reference Point Strategy

This action works best when combined with a strategy to use a fixed reference point for the "live" branch. This ensures consistent diffs even if the live branch is updated during the workflow execution or between workflow runs.

The example workflow above demonstrates a strategy where:

1. On the first run, the current HEAD of the `live` branch is recorded in a PR comment
2. On subsequent runs, the same reference point is extracted from the comment
3. This ensures that all diffs for a specific PR use the same reference point

## License

MIT License - see the LICENSE file for details.
