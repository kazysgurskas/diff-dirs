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

    // Create a temporary script to filter diff output if needed
    let diffCommand = '';
    if (ignoreFilter) {
      const filterScript = '/tmp/filter-diff.js';
      fs.writeFileSync(filterScript, `
const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

const ignoreFilter = ignore().add(${JSON.stringify(ignorePatterns.split(',').map(p => p.trim()))});
let currentFile = null;
let buffer = [];
let skip = false;

process.stdin.on('data', (data) => {
  const lines = data.toString().split('\\n');

  for (const line of lines) {
    if (line.startsWith('diff ')) {
      // If we have a current file, flush it if not skipped
      if (currentFile && !skip && buffer.length > 0) {
        console.log(buffer.join('\\n'));
      }

      // Reset for new file
      buffer = [line];

      // Extract the file path
      const match = line.match(/b\\/(.+)$/);
      currentFile = match ? match[1] : null;

      // Check if this file should be ignored
      skip = currentFile && ignoreFilter.ignores(currentFile);
      if (!skip) {
        console.log(line);
      }
    } else if (!skip) {
      console.log(line);
    }
  }
});

process.stdin.on('end', () => {
  // Flush any remaining content if not skipped
  if (currentFile && !skip && buffer.length > 0) {
    console.log(buffer.join('\\n'));
  }
});
      `);

      diffCommand = `diff -r -u "${sourceDir}" "${targetDir}" | node ${filterScript} > "${outputFile}" || true`;
    } else {
      diffCommand = `diff -r -u "${sourceDir}" "${targetDir}" > "${outputFile}" || true`;
    }

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
 * @returns {Promise<string[]>} - Paths to the generated diff files
 */
async function splitDiffByFiles(diffFile, outputDir) {
  try {
    // Clean previous files if any
    const existingFiles = fs.readdirSync(outputDir)
      .filter(file => file.endsWith('.diff'));

    for (const file of existingFiles) {
      fs.unlinkSync(path.join(outputDir, file));
    }

    // Create a temporary script to split the diff
    const splitScript = '/tmp/split-diff.js';
    fs.writeFileSync(splitScript, `
const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const outputDir = process.argv[3];

const content = fs.readFileSync(inputFile, 'utf8');
const lines = content.split('\\n');

let currentFile = '';
let currentContent = '';
let fileCounter = 0;
const seenFiles = new Map();
const outputFiles = [];

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

    // Extract the file path from the diff header
    let extractedFile = '';
    const gitDiffMatch = line.match(/diff .* a\\/(.+) b\\//);
    const dirDiffMatch = line.match(/diff .* \\"?([^\\"]+)\\"? \\"?([^\\"]+)\\"?/);

    if (gitDiffMatch) {
      extractedFile = gitDiffMatch[1];
    } else if (dirDiffMatch) {
      // Take the second path and extract filename
      const fullPath = dirDiffMatch[2];
      extractedFile = path.basename(fullPath);
    } else {
      extractedFile = \`file_\${fileCounter}\`;
    }

    currentFile = extractedFile;
    currentContent = line;
  } else {
    // Append to current content
    currentContent += '\\n' + line;
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

    const { stdout } = await execAsync(`node ${splitScript} "${diffFile}" "${outputDir}"`);
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to split diff: ${error.message}`);
  }
}

module.exports = {
  generateDiff,
  splitDiffByFiles
};
