#!/usr/bin/env node

/**
 * Repository Sync Script (JavaScript/Node.js version)
 * Syncs GitHub repositories from source to target organizations using Octokit
 * 
 * Usage: 
 *   node sync.js [--file=repo_list_file] [--source-github-token=token] [--target-github-token=token] [options]
 * 
 * Command Line Options:
 *   --file, -f                     Repository list YAML file (default: actions-list.yml)
 *   --source-github-token          GitHub PAT for source repositories
 *   --target-github-token          GitHub PAT for target repositories
 *   --source-github-url            Source GitHub server URL (default: https://github.com)
 *   --target-github-url            Target GitHub server URL (defaults to source URL)
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
 *   node sync.js --file=repos.yml
 *   node sync.js --source-github-token=ghp_xxx --target-github-token=ghp_yyy
 *   node sync.js --source-github-url=https://github.com --target-github-url=https://ghe.company.com --target-github-api-url=https://ghe.company.com/api/v3
 *   node sync.js --overwrite-repo-visibility --file=repos.yml
 *   node sync.js --force-push --file=repos.yml
 * 
 * Environment Variables (fallback order):
 *   1. GitHub Actions inputs (INPUT_* variables) (highest priority)
 *   2. Command line arguments
 *   3. Direct environment variables
 *   
 *   SOURCE_GITHUB_TOKEN / INPUT_SOURCE_GITHUB_TOKEN: Source GitHub Personal Access Token
 *   TARGET_GITHUB_TOKEN / INPUT_TARGET_GITHUB_TOKEN: Target GitHub Personal Access Token
 *   SOURCE_GITHUB_URL / INPUT_SOURCE_GITHUB_URL: Source GitHub server URL
 *   SOURCE_GITHUB_API_URL / INPUT_SOURCE_GITHUB_API_URL: Source GitHub API URL
 *   TARGET_GITHUB_URL / INPUT_TARGET_GITHUB_URL: Target GitHub server URL
 *   TARGET_GITHUB_API_URL / INPUT_TARGET_GITHUB_API_URL: Target GitHub API URL
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
const CREDENTIAL_REGEX = /x-access-token:[^@]+@/g;
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
  .option('source-github-url', {
    type: 'string',
    description: 'Source GitHub server URL',
    default: 'https://github.com'
  })
  .option('target-github-url', {
    type: 'string',
    description: 'Target GitHub server URL',
    default: 'https://github.com'
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
  .example('$0 --source-github-token=ghp_xxx --target-github-token=ghp_yyy', 'Use different tokens for source and target')
  .example('$0 --overwrite-repo-visibility --file=repos.yml', 'Update visibility of existing repos')
  .example('$0 --force-push --file=repos.yml', 'Force push to overwrite target repository history')
  .argv;

// Configuration - prioritize GitHub Actions inputs, then command line args, then environment variables
const REPO_LIST = core.getInput('repo-list-file') ||
  process.env.INPUT_REPO_LIST_FILE ||
  argv.file ||
  'actions-list.yml';

// Safe boolean input reading for local execution
function safeBooleanInput(name) {
  try {
    return core.getBooleanInput(name);
  } catch {
    return false;
  }
}

const OVERWRITE_VISIBILITY = safeBooleanInput('overwrite-repo-visibility') ||
  process.env.INPUT_OVERWRITE_REPO_VISIBILITY === 'true' ||
  argv['overwrite-repo-visibility'] ||
  false;

const FORCE_PUSH = safeBooleanInput('force-push') ||
  process.env.INPUT_FORCE_PUSH === 'true' ||
  argv['force-push'] ||
  false;

// Source configuration
const SOURCE_GITHUB_TOKEN = core.getInput('source-github-token') ||
  process.env.INPUT_SOURCE_GITHUB_TOKEN ||
  argv['source-github-token'] ||
  process.env.SOURCE_GITHUB_TOKEN;

const SOURCE_GITHUB_URL = core.getInput('source-github-url') ||
  process.env.INPUT_SOURCE_GITHUB_URL ||
  argv['source-github-url'] ||
  process.env.SOURCE_GITHUB_URL ||
  'https://github.com';

const SOURCE_GITHUB_API_URL = core.getInput('source-github-api-url') ||
  process.env.INPUT_SOURCE_GITHUB_API_URL ||
  argv['source-github-api-url'] ||
  process.env.SOURCE_GITHUB_API_URL ||
  'https://api.github.com';

// Target configuration
const TARGET_GITHUB_TOKEN = core.getInput('target-github-token') ||
  process.env.INPUT_TARGET_GITHUB_TOKEN ||
  argv['target-github-token'] ||
  process.env.TARGET_GITHUB_TOKEN;

const TARGET_GITHUB_URL = core.getInput('target-github-url') ||
  process.env.INPUT_TARGET_GITHUB_URL ||
  argv['target-github-url'] ||
  process.env.TARGET_GITHUB_URL ||
  SOURCE_GITHUB_URL;

const TARGET_GITHUB_API_URL = core.getInput('target-github-api-url') ||
  process.env.INPUT_TARGET_GITHUB_API_URL ||
  argv['target-github-api-url'] ||
  process.env.TARGET_GITHUB_API_URL ||
  SOURCE_GITHUB_API_URL;

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
core.info(`  Tokens: ${TARGET_GITHUB_TOKEN === SOURCE_GITHUB_TOKEN ? 'same token for both' : 'different tokens'} for source/target`);

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
  console.log(`::group::${name}`);

  try {
    return await fn();
  } finally {
    console.log('::endgroup::');
  }
}

/**
 * Sanitize error messages to remove embedded credentials
 */
function sanitizeError(error) {
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
    console.log(`Command failed (ignoring): ${command}`);
  }
}

/**
 * Check if repository exists, create if it doesn't
 */
async function ensureRepository(targetOrg, targetRepo, visibility = 'private', description = '', overwriteVisibility = false) {
  let created = false;
  let visibilityUpdated = false;

  try {
    const { data: repo } = await targetOctokit.rest.repos.get({
      owner: targetOrg,
      repo: targetRepo
    });

    console.log('repo exists');

    // Check if we need to update visibility
    if (overwriteVisibility) {
      const currentVisibility = repo.visibility;

      console.log(`Current visibility: ${currentVisibility}, Target visibility: ${visibility}`);

      if (currentVisibility !== visibility) {
        console.log(`Updating visibility from ${currentVisibility} to ${visibility}`);
        try {
          await targetOctokit.rest.repos.update({
            owner: targetOrg,
            repo: targetRepo,
            visibility: visibility
          });
          console.log(`repo visibility updated to ${visibility}`);
          visibilityUpdated = true;
        } catch (updateError) {
          core.warning(`Could not update repo visibility: ${updateError.message}`);
        }
      } else {
        console.log(`Visibility already matches (${currentVisibility})`);
      }
    }

    return { created, visibilityUpdated };
  } catch (error) {
    if (error.status === 404) {
      console.log("repo doesn't exist");

      try {
        const isPrivate = visibility === 'private' || visibility === 'internal';
        const { data: newRepo } = await targetOctokit.rest.repos.createInOrg({
          org: targetOrg,
          name: targetRepo,
          private: isPrivate,
          visibility: visibility,
          description: description
        });

        console.log(`repo created (${visibility})`);
        created = true;
        return { created, visibilityUpdated };
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
    console.log('🚫 GitHub Actions disabled');
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
      console.log('📦 Repository is archived, unarchiving for sync...');
      await targetOctokit.rest.repos.update({
        owner: targetOrg,
        repo: targetRepo,
        archived: false
      });
      console.log('📂 Repository unarchived');
      return { wasArchived: true };
    } else {
      console.log('📂 Repository is not archived');
      return { wasArchived: false };
    }
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
    console.log('📦 Repository archived');
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
    'disable-github-actions': disableActionsForRepo = true,    // default to true
    'archive-after-sync': archiveAfterSync = false           // default to false
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

  console.log(`Processing: ${source} → ${target} (${visibility})`);
  console.log(`Using temp directory: ${tempDir}`);

  // Fetch source repository description
  let description = '';
  try {
    const { data: sourceRepo } = await sourceOctokit.rest.repos.get({
      owner: sourceOrg,
      repo: sourceRepoName
    });
    description = sourceRepo.description || '';
    console.log(`Source repo description: ${description || '(no description)'}`);
  } catch (error) {
    core.warning(`Could not fetch source repo description: ${error.message}`);
  }

  // Ensure target repository exists
  const repoStatus = await ensureRepository(targetOrg, targetRepoName, visibility, description, OVERWRITE_VISIBILITY);

  // Ensure repository is unarchived for sync (if archive option is enabled)
  let archiveStatus = { wasArchived: false };
  if (archiveAfterSync) {
    console.log('Checking archive status...');
    archiveStatus = await ensureRepositoryUnarchived(targetOrg, targetRepoName);
  }

  // Disable GitHub Actions if requested
  if (disableActionsForRepo) {
    console.log('Disabling GitHub Actions...');
    await disableActions(targetOrg, targetRepoName);
  }

  const originalCwd = process.cwd();

  try {
    console.log(`Cloning ${cloneUrl}...`);
    execCommand(`git clone --mirror "${authenticatedCloneUrl}" "${repoDir}"`);

    process.chdir(repoDir);

    const authenticatedPushUrl = pushUrl.replace('://', `://x-access-token:${TARGET_GITHUB_TOKEN}@`);

    // Push refs selectively (exclude pull request refs)
    console.log(`Pushing branches and tags to ${targetOrg}/${targetRepoName}...`);

    const forceFlag = FORCE_PUSH ? ' --force' : '';

    // Try to push branches
    try {
      execCommand(`git push${forceFlag} "${authenticatedPushUrl}" 'refs/heads/*:refs/heads/*'`);
      console.log('✅ Branches pushed successfully');
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      core.error('❌ Failed to push branches:', sanitizedError);
      throw new Error(`Failed to push branches: ${sanitizedError}`);
    }

    // Try to push tags
    try {
      execCommand(`git push${forceFlag} "${authenticatedPushUrl}" 'refs/tags/*:refs/tags/*'`);
      console.log('✅ Tags pushed successfully');
    } catch (error) {
      const sanitizedError = sanitizeError(error);
      core.error('❌ Failed to push tags:', sanitizedError);
      throw new Error(`Failed to push tags: ${sanitizedError}`);
    }

    console.log(`✅ Successfully mirrored ${source} → ${target} (${visibility})`);

    // Archive repository if requested
    let archived = false;
    if (archiveAfterSync) {
      console.log('Archiving repository...');
      archived = await archiveRepository(targetOrg, targetRepoName);
    }

    return {
      success: true,
      repo: `${targetOrg}/${targetRepoName}`,
      created: repoStatus.created,
      visibilityUpdated: repoStatus.visibilityUpdated,
      archived: archived
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
    console.log(`Cleaned up temp directory: ${tempDir}`);
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
  let archived = 0;
  const failedRepos = [];

  // Process each repository
  for (const repo of repos) {
    const displayName = `${repo.source} → ${repo.target}`;
    try {
      const result = await githubGroup(displayName, async () => {
        return await mirrorRepository(repo);
      });

      if (result.success) {
        successful++;
        if (result.created) created++;
        else updated++;
        if (result.visibilityUpdated) visibilityUpdated++;
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
  core.info(`📦 Archived: ${archived}`);

  if (failedRepos.length > 0) {
    core.info('\n❌ Failed repositories:');
    failedRepos.forEach(({ repo, error }) => {
      core.info(`  • ${repo}: ${error}`);
    });

    process.exit(1);
  }
}

// Execute main function
main().catch(error => {
  core.error('Script failed:', error.message);
  process.exit(1);
});
