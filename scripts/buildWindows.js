const fs = require('fs')
const path = require('path')
const archiver = require('archiver')
const builder = require('electron-builder')
const Arch = builder.Arch

const packageFile = require('./../package.json')
const version = packageFile.version

const createPackage = require('./createPackage.js')

async function afterPackageBuilt (packagePath) {
  /* create output directory if it doesn't exist */
  if (!fs.existsSync('dist/app')) {
    fs.mkdirSync('dist/app')
  }

  let archSuffix

  if (packagePath.includes('ia32')) {
    archSuffix = '-ia32'
  } else if (packagePath.includes('arm64')) {
    archSuffix = '-arm64'
  } else {
    archSuffix = ''
  }

  /* P1-11.1: distinct artifact naming - this fork is NOT the official Min release.
   * Squirrel file name inside the installer dir follows the package name. */
  const PKG_ID = packageFile.name /* min-agent-edition */
  const ARTIFACT_PREFIX = 'Min-Agent-Edition'

  /* create zip files */
  var output = fs.createWriteStream('dist/app/' + ARTIFACT_PREFIX + '-v' + version + '-windows' + archSuffix + '.zip')
  var archive = archiver('zip', {
    zlib: { level: 9 }
  })
  archive.directory(packagePath, ARTIFACT_PREFIX + '-v' + version)
  archive.pipe(output)
  await archive.finalize()

  /* create installer */
  const installer = require('electron-installer-windows')

  const options = {
    src: packagePath,
    dest: 'dist/app/min-installer' + archSuffix,
    icon: 'icons/icon256.ico',
    animation: 'icons/windows-installer.gif',
    licenseUrl: 'https://github.com/minbrowser/min/blob/master/LICENSE.txt',
    noMsi: true,
    /* P1-11.1: the packaged exe is named from productName ("Min Agent Edition.exe");
     * electron-installer-windows otherwise expects <name>.exe and fails NU5019. */
    exe: 'Min Agent Edition.exe'
  }

  console.log('Creating package (this may take a while)')

  fs.copyFileSync('LICENSE.txt', packagePath + '/LICENSE')

  await installer(options)
    .then(function () {
      /* Squirrel sanitizes the package id to underscores in the setup filename. */
      const ucId = PKG_ID.replace(/-/g, '_')
      const candidates = [
        PKG_ID + '-' + version + '-setup.exe',
        ucId + '-' + version + '-setup.exe',
        'min-' + version + '-setup.exe' /* legacy */
      ]
      const srcExe = candidates.map(c => path.join('dist/app/min-installer' + archSuffix, c)).find(p2 => fs.existsSync(p2))
      if (!srcExe) throw new Error('setup exe not found (tried: ' + candidates.join(', ') + ')')
      fs.renameSync(srcExe, './dist/app/' + ARTIFACT_PREFIX + '-' + version + archSuffix + '-setup.exe')
    })
    .catch(err => {
      console.error(err, err.stack)
      process.exit(1)
    })
}

// creating multiple packages simultaneously causes errors in electron-rebuild, so do one arch at a time instead
createPackage('win32', { arch: Arch.x64 })
  .then(afterPackageBuilt)
  .then(function () {
    return createPackage('win32', { arch: Arch.ia32 })
  })
  .then(afterPackageBuilt)
  .then(function () {
    return createPackage('win32', { arch: Arch.arm64 })
  })
  .then(afterPackageBuilt)
