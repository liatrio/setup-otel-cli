/**
 * Copyright (c) HashiCorp, Inc.
 * Copyright (c) OpenTofu
 * SPDX-License-Identifier: MPL-2.0
 */

// Node.js core
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

// External
const core = require('@actions/core');
const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const releases = require('./releases');

// arch in [arm, x32, x64...] (https://nodejs.org/api/os.html#os_os_arch)
// return value in [amd64, 386, arm]
function mapArch (arch) {
  const mappings = {
    x32: '386',
    x64: 'amd64'
  };
  return mappings[arch] || arch;
}

// os in [darwin, linux, win32...] (https://nodejs.org/api/os.html#os_os_platform)
// return value in [darwin, linux, windows]
function mapOS (os) {
  if (os === 'win32') {
    return 'windows';
  }
  return os;
}

async function downloadAndExtractCLI (url) {
  core.debug(`Downloading OTel CLI from ${url}`);
  const pathToCLIZip = await tc.downloadTool(url);

  if (!pathToCLIZip) {
    throw new Error(`Unable to download OTel CLI from ${url}`);
  }

  let pathToCLI;

  core.debug('Extracting OTel CLI zip file');
  if (os.platform().startsWith('win')) {
    core.debug(`OTel CLI Download Path is ${pathToCLIZip}`);
    const fixedPathToCLIZip = `${pathToCLIZip}.zip`;
    io.mv(pathToCLIZip, fixedPathToCLIZip);
    core.debug(`Moved download to ${fixedPathToCLIZip}`);
    pathToCLI = await tc.extractZip(fixedPathToCLIZip);
  } else {
    pathToCLI = await tc.extractZip(pathToCLIZip);
  }

  core.debug(`OTel CLI path is ${pathToCLI}.`);

  if (!pathToCLI) {
    throw new Error('Unable to unzip OTel');
  }

  return pathToCLI;
}

async function installWrapper (pathToCLI) {
  let source, target;

  // If we're on Windows, then the executable ends with .exe
  const exeSuffix = os.platform().startsWith('win') ? '.exe' : '';

  // Rename otel-cli(.exe) to otel-cli-bin(.exe)
  try {
    source = [pathToCLI, `otel-cli${exeSuffix}`].join(path.sep);
    target = [pathToCLI, `otel-cli-bin${exeSuffix}`].join(path.sep);
    core.debug(`Moving ${source} to ${target}.`);
    await io.mv(source, target);
  } catch (e) {
    core.error(`Unable to move ${source} to ${target}.`);
    throw e;
  }

  // Install our wrapper as otel-cli
  try {
    source = path.resolve([__dirname, '..', 'wrapper', 'dist', 'index.js'].join(path.sep));
    target = [pathToCLI, 'otel-cli'].join(path.sep);
    core.debug(`Copying ${source} to ${target}.`);
    await io.cp(source, target);
  } catch (e) {
    core.error(`Unable to copy ${source} to ${target}.`);
    throw e;
  }

  // Export a new environment variable, so our wrapper can locate the binary
  core.exportVariable('OTEL_CLI_PATH', pathToCLI);
}

// Add credentials to CLI Configuration File
// https://www.tofu.io/docs/commands/cli-config.html
async function addCredentials (credentialsHostname, credentialsToken, osPlat) {
  // format HCL block
  // eslint-disable
  const creds = `
credentials "${credentialsHostname}" {
  token = "${credentialsToken}"
}`.trim();
  // eslint-enable

  // default to OS-specific path
  let credsFile = osPlat === 'win32'
    ? `${process.env.APPDATA}/tofu.rc`
    : `${process.env.HOME}/.tofurc`;

  // override with TF_CLI_CONFIG_FILE environment variable
  credsFile = process.env.TF_CLI_CONFIG_FILE ? process.env.TF_CLI_CONFIG_FILE : credsFile;

  // get containing folder
  const credsFolder = path.dirname(credsFile);

  core.debug(`Creating ${credsFolder}`);
  await io.mkdirP(credsFolder);

  core.debug(`Adding credentials to ${credsFile}`);
  await fs.writeFile(credsFile, creds);
}

async function run () {
  try {
    // Gather GitHub Actions inputs
    const version = core.getInput('tofu_version');
    const credentialsHostname = core.getInput('cli_config_credentials_hostname');
    const credentialsToken = core.getInput('cli_config_credentials_token');
    const wrapper = core.getInput('tofu_wrapper') === 'true';

    // Gather OS details
    const osPlatform = os.platform();
    const osArch = os.arch();

    core.debug(`Finding releases for OpenTofu version ${version}`);
    const release = await releases.getRelease(version);
    const platform = mapOS(osPlatform);
    const arch = mapArch(osArch);
    const build = release.getBuild(platform, arch);
    if (!build) {
      throw new Error(`OpenTofu version ${version} not available for ${platform} and ${arch}`);
    }

    // Download requested version
    const pathToCLI = await downloadAndExtractCLI(build.url);

    // Install our wrapper
    if (wrapper) {
      await installWrapper(pathToCLI);
    }

    // Add to path
    core.addPath(pathToCLI);

    // Add credentials to file if they are provided
    if (credentialsHostname && credentialsToken) {
      await addCredentials(credentialsHostname, credentialsToken, osPlatform);
    }
    return release;
  } catch (error) {
    core.error(error);
    throw error;
  }
}

module.exports = run;