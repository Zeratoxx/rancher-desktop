/**
 * Code signing support for macOS.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { notarize } from '@electron/notarize';
import { build, Arch, Configuration, Platform } from 'app-builder-lib';
import _ from 'lodash';
import plist from 'plist';
import yaml from 'yaml';

import { spawnFile } from '@pkg/utils/childProcess';

type SigningConfig = {
  entitlements: {
    default: string[];
    overrides: {
      paths: string[];
      entitlements: string[];
    }[];
  }
  constraints: {
    paths: string[];
    self?: Record<string, any>;
    parent?: Record<string, any>;
    responsible?: Record<string, any>;
  }[]
  remove: string[];
};

export async function sign(workDir: string): Promise<string> {
  const certFingerprint = process.env.CSC_FINGERPRINT ?? '';
  const appleId = process.env.APPLEID;
  const appleIdPassword = process.env.AC_PASSWORD;
  const teamId = process.env.AC_TEAMID;

  if (certFingerprint.length < 1) {
    throw new Error(`CSC_FINGERPRINT environment variable not set; required to pick signing certificate.`);
  }

  const unpackedDir = path.join(workDir, 'unpacked');
  const appDir = path.join(unpackedDir, 'Rancher Desktop.app');
  const configPath = path.join(appDir, 'Contents/electron-builder.yml');
  const configText = await fs.promises.readFile(configPath, 'utf-8');
  const config: Configuration = yaml.parse(configText);
  const signingConfigPath = path.join(appDir, 'Contents/build/signing-config-mac.yaml');
  const signingConfigText = await fs.promises.readFile(signingConfigPath, 'utf-8');
  const signingConfig: SigningConfig = yaml.parse(signingConfigText, { merge: true });
  const plistsDir = path.join(workDir, 'plists');
  let wroteDefaultEntitlements = false;

  console.log('Removing excess files...');
  await Promise.all(signingConfig.remove.map(async(relpath) => {
    await fs.promises.rm(path.join(appDir, relpath), { recursive: true });
  }));

  console.log('Signing application...');
  // We're not using @electron/osx-sign because it doesn't allow --launch-constraint-*
  await fs.promises.mkdir(plistsDir, { recursive: true });
  for await (const filePath of findFilesToSign(appDir)) {
    const relPath = path.relative(appDir, filePath);
    const fileHash = createHash('sha256').update(relPath, 'utf-8').digest('base64url');
    const args = ['--sign', certFingerprint, '--force', '--timestamp', '--options', 'runtime'];

    // Determine the entitlements
    const entitlementsOverride = signingConfig.entitlements.overrides.find(e => e.paths.includes(relPath));
    let entitlementName = 'default';
    let entitlements = signingConfig.entitlements.default;

    if (entitlementsOverride) {
      entitlementName = fileHash;
      entitlements = entitlementsOverride.entitlements;
    }
    const entitlementFile = path.join(plistsDir, `${ entitlementName }-entitlement.plist`);

    if (!wroteDefaultEntitlements || entitlementName !== 'default') {
      await fs.promises.writeFile(entitlementFile,
        plist.build(Object.fromEntries(entitlements.map(k => [k, true]))));
      wroteDefaultEntitlements ||= entitlementName === 'default';
    }
    args.push('--entitlements', entitlementFile);

    // Determine the launch constraints
    const launchConstraints = signingConfig.constraints.find(c => c.paths.includes(relPath));
    const constraintTypes = ['self', 'parent', 'responsible'] as const;

    for (const constraintType of constraintTypes) {
      const constraint = launchConstraints?.[constraintType];

      if (constraint) {
        const constraintsFile = path.join(plistsDir, `${ fileHash }-constraint-${ constraintType }.plist`);

        await fs.promises.writeFile(constraintsFile, plist.build(evaluateConstraints(constraint)));
        args.push(`--launch-constraint-${ constraintType }`, constraintsFile);
      }
    }

    await spawnFile('codesign', [...args, filePath], { stdio: 'inherit' });
  }

  console.log('Verifying application signature...');
  await spawnFile('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], { stdio: 'inherit' });
  await spawnFile('codesign', ['--display', '--entitlements', '-', appDir], { stdio: 'inherit' });

  if (process.argv.includes('--skip-notarize')) {
    console.warn('Skipping notarization: --skip-notarize given.');
  } else if (appleId && appleIdPassword && teamId) {
    console.log('Notarizing application...');
    await notarize({
      appBundleId: config.appId as string,
      appPath:     appDir,
      appleId,
      appleIdPassword,
      teamId,
    });
  } else {
    const message = [
      'APPLEID, AC_PASSWORD, or AC_TEAMID environment variables not given, cannot notarize.',
      'To force skip notarization, please pass --skip-notarize to signing script.',
    ];

    throw new Error(message.join('\n'));
  }

  console.log('Building disk image...');
  const arch = process.env.M1 ? Arch.arm64 : Arch.x64;
  const productFileName = config.productName?.replace(/\s+/g, '.');
  const productArch = process.env.M1 ? 'aarch64' : 'x86_64';
  const artifactName = `${ productFileName }-\${version}.${ productArch }.\${ext}`;

  // Build the dmg, explicitly _not_ using an identity; we just signed
  // everything as we wanted already.
  const results = await build({
    targets:     new Map([[Platform.MAC, new Map([[arch, ['dmg']]])]]),
    config:      _.merge<Configuration, Configuration>(config, { mac: { artifactName, identity: null } }),
    prepackaged: appDir,
  });

  const dmgFile = results.find(v => v.endsWith('.dmg'));

  if (!dmgFile) {
    throw new Error(`Could not find signed disk image`);
  }
  await spawnFile('codesign', ['--sign', certFingerprint, '--timestamp', dmgFile], { stdio: 'inherit' });

  return dmgFile;
}

/**
 * Recursively walk the given directory and locate files to sign.
 */
async function *findFilesToSign(dir: string): AsyncIterable<string> {
  // When doing code signing, the children must be signed before their parents
  // (so that their signatures can be incorporated into the parent signature,
  // Merkle tree style).
  // Also, for "Foo.app", we can skip "Foo.app/Contents/MacOS/Foo" because the
  // act of signing the app bundle will sign the executable.
  for (const file of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const fullPath = path.resolve(dir, file.name);

    if (file.isSymbolicLink()) {
      // Skip all symlinks; we sign the symlink target instead.
      continue;
    }
    if (file.isDirectory()) {
      yield * findFilesToSign(fullPath);
    }
    if (!file.isFile()) {
      continue; // We only sign regular files.
    }

    if (isBundleExecutable(fullPath)) {
      // For bundles (apps and frameworks), we skip signing the executable
      // itself as it will be signed when signing the bundle.
      continue;
    }

    // For regular files, read the first four bytes of the file and look
    // for Mach-O headers.
    try {
      const file = await fs.promises.open(fullPath);

      try {
        const { buffer } = await file.read({ buffer: Buffer.alloc(4), length: 4 });
        const header = buffer.readUInt32BE();
        const validHeaders = [
          0xFEEDFACF, // Mach-O 64 bit, correct endian
          0xCFFAEDFE, // Mach-O 64 bit, reversed endian
        ];

        if (!validHeaders.includes(header)) {
          continue;
        }
      } finally {
        await file.close();
      }
    } catch {
      console.debug(`Failed to read file ${ fullPath }, assuming no need to sign.`);
      continue;
    }

    // If the file is already signed, don't sign it again.
    try {
      await spawnFile('codesign', ['--verify', '--strict=all', '--test-requirement=anchor apple', fullPath]);
      console.debug(`Skipping signing of already-signed ${ fullPath }`);
    } catch {
      yield fullPath;
    }
  }

  if (dir.endsWith('.app') || dir.endsWith('.framework')) {
    // We need to sign app bundles, if they haven't been signed yet.
    try {
      await spawnFile('codesign', ['--verify', '--strict=all', '--test-requirement=anchor apple', dir]);
      console.debug(`Skipping signing of already-signed ${ dir }`);
    } catch {
      yield dir;
    }
  }
}

/**
 * Detect if the path of a plain file indicates that it's the bundle executable
 */
function isBundleExecutable(fullPath: string): boolean {
  const parts = fullPath.split(path.sep).reverse();

  if (parts.length >= 4) {
    // Foo.app/Contents/MacOS/Foo - the check style here avoids spell checker.
    if (fullPath.endsWith(`${ parts[0] }.app/Contents/MacOS/${ parts[0] }`)) {
      return true;
    }
  }
  if (parts.length >= 4) {
    // Foo.framework/Versions/A/Foo
    if (parts[3] === `${ parts[0] }.framework` && parts[2] === 'Versions') {
      return true;
    }
  }

  return false;
}

/**
 * Given a launch constraint, preprocess it to return values from the environment.
 */
function evaluateConstraints(constraint: Record<string, any>): Record<string, any> {
  return _.mapValues(constraint, (value) => {
    switch (typeof value) {
    case 'string':
      break;
    case 'object':
      if (Array.isArray(value)) {
        return value.map(v => evaluateConstraints(v));
      } else {
        return evaluateConstraints(value);
      }
    default:
      return value;
    }
    switch (value) {
    case '${AC_TEAMID}': // eslint-disable-line no-template-curly-in-string
      return process.env.AC_TEAMID || value;
    default:
      return value;
    }
  });
}
