const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const core = require('@actions/core');
const ignore = require('ignore');

/**
 * Generate a diff between two directories
 *
 * @param {string} sourceDir - Source directory for comparison
 * @param {string} targetDir - Target directory for comparison
 * @param {string} outputFile - File to write the diff to
 * @param {string} ignorePatterns - Comma-separated list of patterns to ignore
 */
async function generateDiff(sourceDir, targetDir, outputFile, ignorePatterns) {
  try {
    // Create ignore filter if patterns are provided
    let ignoreFilter = null;
    if (ignorePatterns && ignorePatterns.trim()) {
      ignoreFilter = ignore().add(ignorePatterns.split(',').map(p => p.trim()));
    }

    // Create a post-processing script to handle "Only in" lines and filter ignored files
    const postProcessScript = '/tmp/post-process-diff.js';
    const sourceDirEscaped = sourceDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const targetDirEscaped = targetDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    fs.writeFileSync(postProcessScript, `
const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

const sourceDir = ${JSON.stringify(sourceDir)};
const targetDir = ${JSON.stringify(targetDir)};
const ignoreFilter = ${ignorePatterns && ignorePatterns.trim()
  ? `ignore().add(${JSON.stringify(ignorePatterns.split(',').map(p => p.trim()))})`
  : 'null'};

let buffer = '';
let output = '';

function shouldIgnore(filePath) {
  if (!ignoreFilter || !filePath) return false;
  // Make path relative to target directory for ignore matching
  const relativePath = filePath.startsWith(targetDir)
    ? filePath.substring(targetDir.length + 1)
    : filePath;
  return ignoreFilter.ignores(relativePath);
}

function processOnlyInLine(line) {
  // Format: "Only in <dir>: <file_or_dir>"
  // Examples:
  //   "Only in /path/to/target: subdir"
  //   "Only in /path/to/target/subdir: file.txt"

  const onlyInMatch = line.match(/^Only in (.+): (.+)$/);
  if (!onlyInMatch) return false;

  const dirPath = onlyInMatch[1];
  const itemName = onlyInMatch[2];

  // Check if this is the target directory (new files)
  if (dirPath === targetDir || dirPath.startsWith(targetDir + '/')) {
    const fullPath = path.join(dirPath, itemName);
    const relativePath = fullPath.startsWith(targetDir)
      ? fullPath.substring(targetDir.length + 1)
      : itemName;

    if (shouldIgnore(relativePath)) {
      return true; // Skip this file
    }

    // Check if it's a file or directory
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        // Generate unified diff format for new file
        const fileContent = fs.readFileSync(fullPath, 'utf8');
        const lines = fileContent.split('\\n');
        const lastNewline = fileContent.endsWith('\\n');

        output += \`diff -r -u \${sourceDir}/\${relativePath} \${targetDir}/\${relativePath}\\n\`;
        output += \`--- /dev/null\\n\`;
        output += \`+++ \${targetDir}/\${relativePath}\\n\`;
        output += \`@@ -0,0 +1,\${lines.length} @@\\n\`;
        lines.forEach(line => {
          output += \`+\${line}\\n\`;
        });
        if (!lastNewline && lines.length > 0) {
          // Remove the last newline we added
          output = output.slice(0, -1);
        }
        return true;
      } else if (stat.isDirectory()) {
        // Recursively process directory
        const dirEntries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const entry of dirEntries) {
          const entryPath = path.join(fullPath, entry.name);
          const entryRelativePath = path.join(relativePath, entry.name);

          if (entry.isFile()) {
            if (!shouldIgnore(entryRelativePath)) {
              const fileContent = fs.readFileSync(entryPath, 'utf8');
              const fileLines = fileContent.split('\\n');
              const fileLastNewline = fileContent.endsWith('\\n');

              output += \`diff -r -u \${sourceDir}/\${entryRelativePath} \${targetDir}/\${entryRelativePath}\\n\`;
              output += \`--- /dev/null\\n\`;
              output += \`+++ \${targetDir}/\${entryRelativePath}\\n\`;
              output += \`@@ -0,0 +1,\${fileLines.length} @@\\n\`;
              fileLines.forEach(line => {
                output += \`+\${line}\\n\`;
              });
              if (!fileLastNewline && fileLines.length > 0) {
                output = output.slice(0, -1);
              }
            }
          }
        }
        return true;
      }
    } catch (err) {
      // If we can't stat the file, skip it
      return true;
    }
  }

  return false;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  const lines = buffer.split('\\n');
  // Keep the last incomplete line in buffer
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (line.startsWith('diff ')) {
      // Check if this file should be ignored
      const dirMatch = line.match(/diff .* "?([^"]+)"? "?([^"]+)"?/);
      if (dirMatch) {
        const targetPath = dirMatch[2];
        const relativePath = targetPath.startsWith(targetDir)
          ? targetPath.substring(targetDir.length + 1)
          : targetPath;

        if (shouldIgnore(relativePath)) {
          // Skip this diff block
          continue;
        }
      }
      output += line + '\\n';
    } else if (line.startsWith('Only in ')) {
      // Process "Only in" lines
      if (!processOnlyInLine(line)) {
        output += line + '\\n';
      }
    } else {
      output += line + '\\n';
    }
  }
});

process.stdin.on('end', () => {
  // Process remaining buffer
  if (buffer) {
    if (buffer.startsWith('Only in ')) {
      processOnlyInLine(buffer);
    } else {
      output += buffer;
    }
  }

  process.stdout.write(output);
});
    `);

    const diffCommand = `diff -r -u "${sourceDir}" "${targetDir}" 2>&1 | node ${postProcessScript} > "${outputFile}" || true`;

    await execAsync(diffCommand);
    return true;
  } catch (error) {
    // Diff returns non-zero exit code if differences are found, which is expected
    if (error.code === 1 && fs.existsSync(outputFile)) {
      return true;
    }
    throw new Error(`Failed to generate diff: ${error.message}`);
  }
}

/**
 * Split a diff file into separate files by changed file
 *
 * @param {string} diffFile - Path to the diff file
 * @param {string} outputDir - Directory to write the split files to
 * @param {boolean} includeHeaders - Whether to include diff headers in the output
 * @param {string} targetDir - Target directory for relative path extraction
 * @returns {Promise<string[]>} - Paths to the generated diff files
 */
async function splitDiffByFiles(diffFile, outputDir, includeHeaders = true, targetDir = '') {
  try {
    // Clean previous files if any
    const existingFiles = fs.readdirSync(outputDir)
      .filter(file => file.endsWith('.diff'));

    for (const file of existingFiles) {
      fs.unlinkSync(path.join(outputDir, file));
    }

    // Create a temporary script to split the diff
    const splitScript = '/tmp/split-diff.js';
    const targetDirEscaped = targetDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.writeFileSync(splitScript, `
const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const outputDir = process.argv[3];
const includeHeaders = process.argv[4] === 'true';
const targetDir = ${JSON.stringify(targetDir)};

function extractRelativePath(fullPath) {
  if (!targetDir || !fullPath) return fullPath;

  // Normalize paths for comparison
  const normalizedTarget = path.resolve(targetDir).replace(/\\\\/g, '/');
  const normalizedPath = path.resolve(fullPath).replace(/\\\\/g, '/');

  // If the path starts with the target directory, extract relative path
  if (normalizedPath.startsWith(normalizedTarget + '/')) {
    return normalizedPath.substring(normalizedTarget.length + 1);
  }

  // If it's already a relative path or doesn't match, return as-is
  return fullPath;
}

const content = fs.readFileSync(inputFile, 'utf8');
const lines = content.split('\\n');

let currentFile = '';
let currentContent = '';
let fileCounter = 0;
const seenFiles = new Map();
const outputFiles = [];
let inContentSection = false;
let pendingDiffLine = null;
let pendingPlusPlusLine = null;

// Process each line
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Check if this is a diff header line
  if (line.startsWith('diff ')) {
    // If we were processing a file, save it
    if (currentFile && currentContent) {
      // Create a sanitized filename
      let safeFilename = currentFile.replace(/[^a-zA-Z0-9._-]/g, '_');

      // Check if we've seen this file before
      if (seenFiles.has(safeFilename)) {
        const counter = seenFiles.get(safeFilename) + 1;
        seenFiles.set(safeFilename, counter);
        safeFilename = \`\${safeFilename}_\${counter}\`;
      } else {
        seenFiles.set(safeFilename, 1);
      }

      // Save with padded counter prefix
      const paddedCounter = String(fileCounter).padStart(3, '0');
      const outputPath = path.join(outputDir, \`\${paddedCounter}_\${safeFilename}.diff\`);
      fs.writeFileSync(outputPath, currentContent);
      outputFiles.push(outputPath);
      fileCounter++;
    }

    // Try to extract file path from diff line first (fallback)
    const gitDiffMatch = line.match(/diff .* a\\/(.+) b\\//);
    const dirDiffMatch = line.match(/diff .* \\"?([^\\"]+)\\"? \\"?([^\\"]+)\\"?/);

    if (gitDiffMatch) {
      currentFile = gitDiffMatch[1];
    } else if (dirDiffMatch && dirDiffMatch[2]) {
      // Extract relative path from the target path (second path)
      currentFile = extractRelativePath(dirDiffMatch[2]);
    }

    pendingDiffLine = line;
    pendingPlusPlusLine = null;
    inContentSection = false;
    currentContent = includeHeaders ? line : '';
  } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    // These are the file identifier lines, include them only if headers are enabled
    if (includeHeaders && currentContent) {
      currentContent += '\\n' + line;
    }

    // Extract file path from +++ line (target file) - this is more reliable
    if (line.startsWith('+++ ')) {
      pendingPlusPlusLine = line;
      const plusMatch = line.match(/\\+\\+\\+ (?:[ab]\\/)?(.+)/);
      if (plusMatch && plusMatch[1] && plusMatch[1] !== '/dev/null') {
        const fullPath = plusMatch[1];
        // Extract relative path
        const relativePath = extractRelativePath(fullPath);
        // Override currentFile if we have a better path from +++ line
        currentFile = relativePath;
      }
    }
  } else if (line.startsWith('@@ ')) {
    // These are the hunk headers, include them only if headers are enabled
    if (includeHeaders && currentContent) {
      currentContent += '\\n' + line;
    }
    // Mark that we're now in the content section (after this hunk header)
    inContentSection = true;
  } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
    // This is actual diff content, always include
    if (inContentSection) {
      if (currentContent) {
        currentContent += '\\n' + line;
      } else {
        currentContent = line;
      }
    } else if (includeHeaders && currentContent) {
      // If we're not in content section yet but headers are enabled, include this line
      currentContent += '\\n' + line;
    }
  } else if (currentContent) {
    // For any other lines, include them only if headers are enabled
    if (includeHeaders) {
      currentContent += '\\n' + line;
    }
  }
}

// Save the last file if any
if (currentFile && currentContent) {
  let safeFilename = currentFile.replace(/[^a-zA-Z0-9._-]/g, '_');

  if (seenFiles.has(safeFilename)) {
    const counter = seenFiles.get(safeFilename) + 1;
    safeFilename = \`\${safeFilename}_\${counter}\`;
  }

  const paddedCounter = String(fileCounter).padStart(3, '0');
  const outputPath = path.join(outputDir, \`\${paddedCounter}_\${safeFilename}.diff\`);
  fs.writeFileSync(outputPath, currentContent);
  outputFiles.push(outputPath);
}

// Output the list of files for the parent process
console.log(JSON.stringify(outputFiles));
    `);

    const { stdout } = await execAsync(`node ${splitScript} "${diffFile}" "${outputDir}" "${includeHeaders}" "${targetDir}"`);
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to split diff: ${error.message}`);
  }
}

module.exports = {
  generateDiff,
  splitDiffByFiles
};
