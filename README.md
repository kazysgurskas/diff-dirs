# Diff Directories Action

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

## Example Workflow

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
