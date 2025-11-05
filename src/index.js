#!/usr/bin/env node

/**
 * Repository Sync Script (JavaScript/Node.js version)
 * Syncs GitHub repositories from source to target organizations using Octokit
 *
 * Usage:
 *   node index.js [--file=repo_list_file] [--source-github-token=token] [--target-github-token=token] [options]
 *
 * Command Line Options:
 *   --file, -f                     Repository list YAML file (default: actions-list.yml)
 *   --source-github-token          GitHub PAT for source repositories
 *   --target-github-token          GitHub PAT for target repositories
 *   --source-github-api-url        Source GitHub API URL (default: https://api.github.com)
 *   --target-github-api-url        Target GitHub API URL (defaults to source API URL)
 *   --overwrite-repo-visibility    Overwrite visibility of existing repos to match YAML (default: false)
 *   --force-push                   Force push to target repositories (default: false)
 *   --help, -h                     Show help
 *
 * Repository List Format (YAML):
 *   repos:
 *     - source: org1/repo1
 *       target: org2/repo1
 *       visibility: private              # private, public, or internal (defaults to private)
 *       disable-github-actions: true     # defaults to true
 *       archive-after-sync: false        # defaults to false
 *     - source: org1/repo2
 *       target: org2/repo2
 *       visibility: public
 *       disable-github-actions: false    # override default
 *       archive-after-sync: true         # override default
 *
 * Examples:
 *   node index.js --file=repos.yml
 *   node index.js --source-github-token=ghp_xxx --target-github-token=ghp_yyy
 *   node index.js --target-github-api-url=https://ghe.company.com/api/v3
 *   node index.js --source-github-api-url=https://api.github.com --target-github-api-url=https://api.customersuccess.ghe.com
 *   node index.js --overwrite-repo-visibility --file=repos.yml
 *   node index.js --force-push --file=repos.yml
 *
 * Environment Variables (fallback order):
 *   1. GitHub Actions inputs (INPUT_* variables) (highest priority)
 *   2. Command line arguments
 *   3. Direct environment variables
 *
 *   SOURCE_GITHUB_TOKEN / INPUT_SOURCE_GITHUB_TOKEN: Source GitHub Personal Access Token
 *   TARGET_GITHUB_TOKEN / INPUT_TARGET_GITHUB_TOKEN: Target GitHub Personal Access Token
 *   SOURCE_GITHUB_API_URL / INPUT_SOURCE_GITHUB_API_URL: Source GitHub API URL (instance URL auto-derived)
 *   TARGET_GITHUB_API_URL / INPUT_TARGET_GITHUB_API_URL: Target GitHub API URL (instance URL auto-derived)
 */

import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as core from '@actions/core';
import * as yaml from 'js-yaml';

// Constants
const CREDENTIAL_REGEX = /x-access-token:[^@]{1,200}@/g;
const CREDENTIAL_REPLACEMENT = 'x-access-token:***@';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('file', {
    alias: 'f',
    type: 'string',
    description: 'Repository list YAML file'
  })
  .option('source-github-token', {
    type: 'string',
    description: 'GitHub PAT for source repositories'
  })
  .option('target-github-token', {
    type: 'string',
    description: 'GitHub PAT for target repositories'
  })
  .option('source-github-api-url', {
    type: 'string',
    description: 'Source GitHub API URL',
    default: 'https://api.github.com'
  })
  .option('target-github-api-url', {
    type: 'string',
    description: 'Target GitHub API URL',
    default: 'https://api.github.com'
  })
  .option('overwrite-repo-visibility', {
    type: 'boolean',
    description: 'Overwrite visibility of existing repositories to match YAML config',
    default: false
  })
  .option('force-push', {
    type: 'boolean',
    description: 'Force push to target repositories (overwrites history)',
    default: false
  })
  .help()
  .alias('help', 'h')
  .example('$0 --file=repos.yml', 'Sync repositories listed in repos.yml')
  .example(
    '$0 --source-github-token=ghp_xxx --target-github-token=ghp_yyy',
    'Use different tokens for source and target'
  )
  .example('$0 --overwrite-repo-visibility --file=repos.yml', 'Update visibility of existing repos')
  .example('$0 --force-push --file=repos.yml', 'Force push to overwrite target repository history')
  .wrap(null)
  .version()
  .parse();

/**
 * Derive instance/server URL from API URL
 * @param {string} apiUrl - The API URL
 * @returns {string} The instance/server URL
 */
export function deriveInstanceUrl(apiUrl) {
  try {
    const url = new URL(apiUrl);

    // GitHub.com case
    if (url.hostname === 'api.github.com') {
      return 'https://github.com';
    }

    // Check if this looks like it already contains 'api' in the hostname (e.g., api.customersuccess.ghe.com)
    // Remove 'api.' prefix if present
    let hostname = url.hostname;
    if (hostname.startsWith('api.')) {
      hostname = hostname.substring(4); // Remove 'api.' prefix
    }

    // GitHub Enterprise Server case - remove /api/v3 or similar path
    const instanceUrl = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`;
    return instanceUrl;
  } catch (error) {
    core.warning(`Failed to parse API URL "${apiUrl}": ${error.message}`);
    return apiUrl;
  }
}

// Configuration - prioritize GitHub Actions inputs, then command line args, then environment variables
const REPO_LIST =
  core.getInput('repo-list-file') || process.env.INPUT_REPO_LIST_FILE || argv.file || 'actions-list.yml';

// Safe boolean input reading for local execution
function safeBooleanInput(name) {
  try {
    return core.getBooleanInput(name);
  } catch {
    return false;
  }
}

const OVERWRITE_VISIBILITY =
  safeBooleanInput('overwrite-repo-visibility') ||
  process.env.INPUT_OVERWRITE_REPO_VISIBILITY === 'true' ||
  argv['overwrite-repo-visibility'] ||
  false;

const FORCE_PUSH =
  safeBooleanInput('force-push') || process.env.INPUT_FORCE_PUSH === 'true' || argv['force-push'] || false;

// Source configuration
const SOURCE_GITHUB_TOKEN =
  core.getInput('source-github-token') ||
  process.env.INPUT_SOURCE_GITHUB_TOKEN ||
  argv['source-github-token'] ||
  process.env.SOURCE_GITHUB_TOKEN;

const SOURCE_GITHUB_API_URL =
  core.getInput('source-github-api-url') ||
  process.env.INPUT_SOURCE_GITHUB_API_URL ||
  argv['source-github-api-url'] ||
  process.env.SOURCE_GITHUB_API_URL ||
  'https://api.github.com';

// Derive source instance URL from API URL
const SOURCE_GITHUB_URL = deriveInstanceUrl(SOURCE_GITHUB_API_URL);

// Target configuration
const TARGET_GITHUB_TOKEN =
  core.getInput('target-github-token') ||
  process.env.INPUT_TARGET_GITHUB_TOKEN ||
  argv['target-github-token'] ||
  process.env.TARGET_GITHUB_TOKEN;

const TARGET_GITHUB_API_URL =
  core.getInput('target-github-api-url') ||
  process.env.INPUT_TARGET_GITHUB_API_URL ||
  argv['target-github-api-url'] ||
  process.env.TARGET_GITHUB_API_URL ||
  SOURCE_GITHUB_API_URL;

// Derive target instance URL from API URL
const TARGET_GITHUB_URL = deriveInstanceUrl(TARGET_GITHUB_API_URL);

// Validation
if (!SOURCE_GITHUB_TOKEN) {
  core.error('Error: SOURCE_GITHUB_TOKEN is required');
  process.exit(1);
}

if (!TARGET_GITHUB_TOKEN) {
  core.error('Error: TARGET_GITHUB_TOKEN is required');
  process.exit(1);
}

core.info('Configuration:');
core.info(`  Source: ${SOURCE_GITHUB_URL} (API: ${SOURCE_GITHUB_API_URL})`);
core.info(`  Target: ${TARGET_GITHUB_URL} (API: ${TARGET_GITHUB_API_URL})`);
core.info(
  `  Tokens: ${TARGET_GITHUB_TOKEN === SOURCE_GITHUB_TOKEN ? 'same token for both' : 'different tokens'} for source/target`
);

const repoListPath = resolve(REPO_LIST);
if (!existsSync(repoListPath)) {
  core.error(`Error: Repository list file '${REPO_LIST}' not found`);
  process.exit(1);
}

// Initialize Octokit instances
const sourceOctokit = new Octokit({
  auth: SOURCE_GITHUB_TOKEN,
  baseUrl: SOURCE_GITHUB_API_URL === 'https://api.github.com' ? undefined : SOURCE_GITHUB_API_URL
});

const targetOctokit = new Octokit({
  auth: TARGET_GITHUB_TOKEN,
  baseUrl: TARGET_GITHUB_API_URL === 'https://api.github.com' ? undefined : TARGET_GITHUB_API_URL
});

/**
 * GitHub Actions grouping helper
 */
async function githubGroup(name, fn) {
  core.info(`::group::${name}`);

  try {
    return await fn();
  } finally {
    core.info('::endgroup::');
  }
}

/**
 * Sanitize error messages to remove embedded credentials
 */
export function sanitizeError(error) {
  return error.message.replace(CREDENTIAL_REGEX, CREDENTIAL_REPLACEMENT);
}

/**
 * Execute shell command with error handling
 */
function execCommand(command, options = {}) {
  try {
    return execSync(command, {
      stdio: 'inherit',
      encoding: 'utf8',
      ...options
    });
  } catch (error) {
    if (!options.ignoreErrors) {
      error.message = sanitizeError(error);
      throw error;
    }
    core.info(`Command failed (ignoring): ${command}`);
  }
}

/**
 * Check if repository exists, create if it doesn't
 */
async function ensureRepository(
  targetOrg,
  targetRepo,
  visibility = 'private',
  description = '',
  overwriteVisibility = false
) {
  const status = {
    created: false,
    visibilityUpdated: false,
    descriptionUpdated: false
  };

  try {
    const { data: repo } = await targetOctokit.rest.repos.get({
      owner: targetOrg,
      repo: targetRepo
    });

    core.info('repo exists');

    const updates = {};
    let needsUpdate = false;

    // Check if we need to update visibility
    if (overwriteVisibility) {
      const currentVisibility = repo.visibility;

      core.info(`Current visibility: ${currentVisibility}, Target visibility: ${visibility}`);

      if (currentVisibility !== visibility) {
        core.info(`Updating visibility from ${currentVisibility} to ${visibility}`);
        updates.visibility = visibility;
        status.visibilityUpdated = true;
        needsUpdate = true;
      } else {
        core.info(`Visibility already matches (${currentVisibility})`);
      }
    }

    // Check if we need to update description
    const currentDescription = repo.description || '';
    const targetDescription = description || '';

    if (currentDescription !== targetDescription) {
      core.info(`Description differs - updating from "${currentDescription}" to "${targetDescription}"`);
      updates.description = targetDescription;
      status.descriptionUpdated = true;
      needsUpdate = true;
    } else {
      core.info(`Description already matches`);
    }

    // Apply updates if needed
    if (needsUpdate) {
      try {
        await targetOctokit.rest.repos.update({
          owner: targetOrg,
          repo: targetRepo,
          ...updates
        });
        core.info(`Repository updated successfully`);
      } catch (updateError) {
        core.warning(`Could not update repository: ${updateError.message}`);
      }
    }

    return status;
  } catch (error) {
    if (error.status === 404) {
      core.info(`repo does not exist`);

      try {
        const isPrivate = visibility === 'private' || visibility === 'internal';
        await targetOctokit.rest.repos.createInOrg({
          org: targetOrg,
          name: targetRepo,
          private: isPrivate,
          visibility,
          description
        });

        core.info(`repo created (${visibility})`);
        status.created = true;
        return status;
      } catch (createError) {
        core.error(`repo creation failed: ${createError.message}`);
        throw new Error(`Failed to create repository ${targetOrg}/${targetRepo}: ${createError.message}`);
      }
    } else {
      core.error(`query repo failed: ${error.message}`);
      throw new Error(`Failed to query repository ${targetOrg}/${targetRepo}: ${error.message}`);
    }
  }
}

/**
 * Disable GitHub Actions on a repository
 */
async function disableActions(targetOrg, targetRepo) {
  try {
    await targetOctokit.rest.actions.setGithubActionsPermissionsRepository({
      owner: targetOrg,
      repo: targetRepo,
      enabled: false
    });
    core.info('🚫 GitHub Actions disabled');
    return true;
  } catch (error) {
    core.warning(`Could not disable GitHub Actions: ${error.message}`);
    return false;
  }
}

/**
 * Check if repository is archived and unarchive if needed
 */
async function ensureRepositoryUnarchived(targetOrg, targetRepo) {
  try {
    const { data: repo } = await targetOctokit.rest.repos.get({
      owner: targetOrg,
      repo: targetRepo
    });

    if (repo.archived) {
      core.info('📦 Repository is archived, unarchiving for sync...');
      await targetOctokit.rest.repos.update({
        owner: targetOrg,
        repo: targetRepo,
        archived: false
      });
      core.info('📂 Repository unarchived');
      return { wasArchived: true };
    }
    core.info('📂 Repository is not archived');
    return { wasArchived: false };
  } catch (error) {
    core.warning(`Could not check/unarchive repository: ${error.message}`);
    return { wasArchived: false };
  }
}

/**
 * Archive a repository
 */
async function archiveRepository(targetOrg, targetRepo) {
  try {
    await targetOctokit.rest.repos.update({
      owner: targetOrg,
      repo: targetRepo,
      archived: true
    });
    core.info('📦 Repository archived');
    return true;
  } catch (error) {
    core.warning(`Could not archive repository: ${error.message}`);
    return false;
  }
}

/**
 * Mirror repository from source to target
 */
async function mirrorRepository(repoConfig) {
  const {
    source,
    target,
    visibility = 'private',
    'disable-github-actions': disableActionsForRepo = true, // default to true
    'archive-after-sync': archiveAfterSync = false // default to false
  } = repoConfig;
  const [sourceOrg, sourceRepoName] = source.split('/');
  const [targetOrg, targetRepoName] = target.split('/');

  const cloneUrl = `${SOURCE_GITHUB_URL}/${source}.git`;
  const pushUrl = `${TARGET_GITHUB_URL}/${target}.git`;

  // Set up authenticated URLs
  const authenticatedCloneUrl = cloneUrl.replace('://', `://x-access-token:${SOURCE_GITHUB_TOKEN}@`);

  // Create temporary directory for cloning
  const tempDir = mkdtempSync(join(tmpdir(), 'repo-sync-'));
  const repoDir = join(tempDir, `${sourceRepoName}.git`);

  core.info(`Processing: ${source} → ${target} (${visibility})`);
  core.info(`Using temp directory: ${tempDir}`);

  // Fetch source repository description
  let description = '';
  try {
    const { data: sourceRepo } = await sourceOctokit.rest.repos.get({
      owner: sourceOrg,
      repo: sourceRepoName
    });
    description = sourceRepo.description || '';
    core.info(`Source repo description: ${description || '(no description)'}`);
  } catch (error) {
    core.warning(`Could not fetch source repo description: ${error.message}`);
  }

  // Ensure target repository exists
  const repoStatus = await ensureRepository(targetOrg, targetRepoName, visibility, description, OVERWRITE_VISIBILITY);

  // Ensure repository is unarchived for sync (if archive option is enabled)
  if (archiveAfterSync) {
    core.info('Checking archive status...');
    await ensureRepositoryUnarchived(targetOrg, targetRepoName);
  }

  // Disable GitHub Actions if requested
  if (disableActionsForRepo) {
    core.info('Disabling GitHub Actions...');
    await disableActions(targetOrg, targetRepoName);
  }

  const originalCwd = process.cwd();

  try {
    core.info(`Cloning ${cloneUrl}...`);
    execCommand(`git clone --mirror "${authenticatedCloneUrl}" "${repoDir}"`);

    process.chdir(repoDir);

    const authenticatedPushUrl = pushUrl.replace('://', `://x-access-token:${TARGET_GITHUB_TOKEN}@`);

    // Push refs selectively (exclude pull request refs)
    core.info(`Pushing branches and tags to ${targetOrg}/${targetRepoName}...`);

    const forceFlag = FORCE_PUSH ? ' --force' : '';

    // Try to push branches
    try {
      execCommand(`git push${forceFlag} "${authenticatedPushUrl}" 'refs/heads/*:refs/heads/*'`);
      core.info('✅ Branches pushed successfully');
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      core.error('❌ Failed to push branches:', sanitizedError);
      throw new Error(`Failed to push branches: ${sanitizedError}`);
    }

    // Try to push tags
    try {
      execCommand(`git push${forceFlag} "${authenticatedPushUrl}" 'refs/tags/*:refs/tags/*'`);
      core.info('✅ Tags pushed successfully');
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      core.error('❌ Failed to push tags:', sanitizedError);
      throw new Error(`Failed to push tags: ${sanitizedError}`);
    }

    core.info(`✅ Successfully mirrored ${source} → ${target} (${visibility})`);

    // Archive repository if requested
    let archived = false;
    if (archiveAfterSync) {
      core.info('Archiving repository...');
      archived = await archiveRepository(targetOrg, targetRepoName);
    }

    return {
      success: true,
      repo: `${targetOrg}/${targetRepoName}`,
      created: repoStatus.created,
      visibilityUpdated: repoStatus.visibilityUpdated,
      descriptionUpdated: repoStatus.descriptionUpdated,
      archived
    };
  } catch (error) {
    core.error(`❌ Failed to mirror ${source}: ${error.message}`);
    return {
      success: false,
      repo: `${targetOrg}/${targetRepoName}`,
      error: error.message
    };
  } finally {
    process.chdir(originalCwd);
    execCommand(`rm -rf "${tempDir}"`, { ignoreErrors: true });
    core.info(`Cleaned up temp directory: ${tempDir}`);
  }
}

/**
 * Main execution function
 */
async function main() {
  core.info(`Looping through ${REPO_LIST} ...`);

  const content = readFileSync(repoListPath, 'utf8');

  let config;
  try {
    config = yaml.load(content);
  } catch (yamlError) {
    core.error(`Error parsing YAML file: ${yamlError.message}`);
    process.exit(1);
  }

  const repos = config.repos || [];

  if (repos.length === 0) {
    core.info('No repositories to process');
    return;
  }

  core.info(`Found ${repos.length} repositories to sync`);

  let successful = 0;
  let failed = 0;
  let created = 0;
  let updated = 0;
  let visibilityUpdated = 0;
  let descriptionUpdated = 0;
  let archived = 0;
  const failedRepos = [];

  // Process each repository
  for (const repo of repos) {
    const displayName = `${repo.source} → ${repo.target}`;
    try {
      const result = await githubGroup(displayName, async () => {
        return mirrorRepository(repo);
      });

      if (result.success) {
        successful++;
        if (result.created) created++;
        else updated++;
        if (result.visibilityUpdated) visibilityUpdated++;
        if (result.descriptionUpdated) descriptionUpdated++;
        if (result.archived) archived++;
      } else {
        failed++;
        failedRepos.push({ repo: displayName, error: result.error });
      }
    } catch (error) {
      failed++;
      failedRepos.push({ repo: displayName, error: error.message });
    }
  }

  // Print summary
  core.info('\n=== SYNC SUMMARY ===');
  core.info(`Total repositories: ${repos.length}`);
  core.info(`✅ Successful: ${successful}`);
  core.info(`❌ Failed: ${failed}`);
  core.info(`🆕 Created: ${created}`);
  core.info(`🔄 Updated: ${updated}`);
  if (OVERWRITE_VISIBILITY) {
    core.info(`👁️  Visibility updated: ${visibilityUpdated}`);
  }
  core.info(`📝 Description updated: ${descriptionUpdated}`);
  core.info(`📦 Archived: ${archived}`);

  if (failedRepos.length > 0) {
    core.info('\n❌ Failed repositories:');
    for (const { repo, error } of failedRepos) {
      core.info(`  • ${repo}: ${error}`);
    }

    process.exit(1);
  }
}

// Execute main function
(async () => {
  try {
    await main();
  } catch (error) {
    core.error('Script failed:', error.message);
    process.exit(1);
  }
})();
