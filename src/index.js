const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { generateDiff, splitDiffByFiles } = require('./utils');

async function run() {
  try {
    // Get inputs
    const token = core.getInput('token');
    const sourceDir = core.getInput('source-dir');
    const targetDir = core.getInput('target-dir');
    const maxCommentSize = parseInt(core.getInput('max-comment-size'));
    const ignorePatterns = core.getInput('ignore-patterns');
    const deletePreviousComments = core.getInput('delete-previous-comments') === 'true';

    // Validate input
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory does not exist: ${sourceDir}`);
    }
    if (!fs.existsSync(targetDir)) {
      throw new Error(`Target directory does not exist: ${targetDir}`);
    }

    // Initialize GitHub client
    const octokit = github.getOctokit(token);
    const context = github.context;
    const { owner, repo } = context.repo;
    const prNumber = context.payload.pull_request?.number;

    if (!prNumber) {
      throw new Error('This action can only be run on pull request events');
    }

    // Create temp directory for diffs
    const diffDir = '/tmp/diff-files';
    if (!fs.existsSync(diffDir)) {
      fs.mkdirSync(diffDir, { recursive: true });
    }

    // Generate raw diff
    core.info('Generating diff between directories...');
    const rawDiffFile = path.join(diffDir, 'raw-diff.txt');
    await generateDiff(sourceDir, targetDir, rawDiffFile, ignorePatterns);

    // Split diff by files
    core.info('Splitting diff by files...');
    const diffFiles = await splitDiffByFiles(rawDiffFile, diffDir);
    core.info(`Generated ${diffFiles.length} diff files`);

    // Delete previous comments if required
    if (deletePreviousComments) {
      core.info('Deleting previous diff comments...');
      await deletePreviousDiffComments(octokit, owner, repo, prNumber);
    }

    // If no diff files, post a single comment
    if (diffFiles.length === 0) {
      core.info('No differences found, posting a single comment');
      await postComment(
        octokit,
        owner,
        repo,
        prNumber,
        `### No differences\nNo differences found.`
      );
      return;
    }

    // Proceed directly to posting individual diff comments
    core.info('Posting individual diff comments...');

    // Post each file diff as a separate comment
    core.info('Posting individual diff comments...');
    for (const file of diffFiles) {
      const diffContent = fs.readFileSync(file, 'utf8');
      const fileName = path.basename(file).replace(/^\d+_/, '').replace('.diff', '');

      // Extract file basename from the diff content
      const fileBasename = extractFileBasename(diffContent);

      // Handle large diffs by splitting into multiple comments if needed
      if (diffContent.length > maxCommentSize - 100) {
        const chunks = splitLargeContent(diffContent, maxCommentSize - 100);

        for (let i = 0; i < chunks.length; i++) {
          const title = i === 0 ?
            `### ${fileBasename}` :
            `### ${fileBasename} (continued ${i+1}/${chunks.length})`;

          await postComment(
            octokit,
            owner,
            repo,
            prNumber,
            `${title}\n\`\`\`diff\n${chunks[i]}\n\`\`\``
          );

          // Add a small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else {
        // Post as a single comment
        await postComment(
          octokit,
          owner,
          repo,
          prNumber,
          `### ${fileBasename}\n\`\`\`diff\n${diffContent}\n\`\`\``
        );

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    core.info('All diff comments posted successfully!');
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

async function deletePreviousDiffComments(octokit, owner, repo, prNumber) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100
  });

  // Filter comments that look like diff comments (have diff code blocks or "No differences" title)
  const diffComments = comments.filter(comment =>
    (comment.body.includes('```diff') && comment.body.includes('###')) ||
    comment.body.includes('### No differences')
  );

  for (const comment of diffComments) {
    await octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: comment.id
    });
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function postComment(octokit, owner, repo, prNumber, body) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body
  });
}

/**
 * Extract the filename basename from diff content
 *
 * @param {string} diffContent - The diff content
 * @returns {string} - The basename of the file
 */
function extractFileBasename(diffContent) {
  // Try to extract the filename from the diff header line
  const lines = diffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff ')) {
      // Try git diff format - "diff --git a/path/to/file b/path/to/file"
      const gitMatch = line.match(/diff --git a\/(.+) b\/.+/);
      if (gitMatch && gitMatch[1]) {
        return path.basename(gitMatch[1]);
      }

      // Try directory diff format - "diff -r /path1/file /path2/file"
      const dirMatch = line.match(/diff .* "?([^"]+)"? "?([^"]+)"?/);
      if (dirMatch && dirMatch[2]) {
        return path.basename(dirMatch[2]);
      }

      // Try other diff formats
      const pathMatch = line.match(/diff .* [ab]\/(.*)/);
      if (pathMatch && pathMatch[1]) {
        return path.basename(pathMatch[1]);
      }
    }

    // Also check for +++ and --- lines which often contain filenames
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const fileMatch = line.match(/(?:---|\+\+\+) (?:[ab]\/)?(.+)/);
      if (fileMatch && fileMatch[1] && fileMatch[1] !== '/dev/null') {
        return path.basename(fileMatch[1]);
      }
    }
  }

  // If we can't extract the filename, return a generic name
  return "File";
}

function splitLargeContent(content, maxSize) {
  const chunks = [];
  let currentChunk = '';

  // Split by lines to preserve line integrity
  const lines = content.split('\n');
  for (const line of lines) {
    // If adding this line would exceed max size, start a new chunk
    if (currentChunk.length + line.length + 1 > maxSize) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }

  // Add the last chunk
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

run();
