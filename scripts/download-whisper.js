const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const binNativeDir = path.join(rootDir, 'bin', 'native');
  const binModelsDir = path.join(rootDir, 'bin', 'models');

  if (!fs.existsSync(binNativeDir)) fs.mkdirSync(binNativeDir, { recursive: true });
  if (!fs.existsSync(binModelsDir)) fs.mkdirSync(binModelsDir, { recursive: true });

  // 1. Download model: ggml-tiny.en-q5_1.bin (~31MB) -> bin/models/ggml-tiny.en.bin
  const targetModel = path.join(binModelsDir, 'ggml-tiny.en.bin');
  if (!fs.existsSync(targetModel) || fs.statSync(targetModel).size < 30000000) {
    console.log('[download-whisper] Downloading ggml-tiny.en-q5_1.bin (~31MB)...');
    const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin';
    const modelRes = await fetch(modelUrl, { redirect: 'follow' });
    if (!modelRes.ok) throw new Error(`Model download failed: ${modelRes.statusText}`);
    const fileStream = fs.createWriteStream(targetModel);
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => {
      Readable.fromWeb(modelRes.body).pipe(fileStream)
        .on('finish', resolve)
        .on('error', reject);
    });
    console.log(`[download-whisper] Downloaded model: ${fs.statSync(targetModel).size} bytes`);
  } else {
    console.log('[download-whisper] Model already present:', targetModel);
  }

  // 2. Download whisper binary archive
  const targetCli = path.join(binNativeDir, 'whisper-cli.exe');
  if (!fs.existsSync(targetCli)) {
    console.log('[download-whisper] Downloading whisper-bin-x64.zip...');
    const zipUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip';
    const zipRes = await fetch(zipUrl, { redirect: 'follow' });
    if (!zipRes.ok) throw new Error(`Zip download failed: ${zipRes.statusText}`);
    const tempZip = path.join(rootDir, 'temp-whisper.zip');
    const fileStream = fs.createWriteStream(tempZip);
    const { Readable } = require('stream');
    await new Promise((resolve, reject) => {
      Readable.fromWeb(zipRes.body).pipe(fileStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    console.log('[download-whisper] Extracting whisper archive...');
    const tempExtract = path.join(rootDir, 'temp-whisper-extract');
    if (!fs.existsSync(tempExtract)) fs.mkdirSync(tempExtract, { recursive: true });

    // Use tar.exe or powershell Expand-Archive
    execSync(`tar -xf "${tempZip}" -C "${tempExtract}"`, { stdio: 'inherit' });

    function findFiles(dir) {
      let results = [];
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory()) {
          results = results.concat(findFiles(full));
        } else {
          results.push(full);
        }
      }
      return results;
    }

    const allFiles = findFiles(tempExtract);
    console.log('[download-whisper] All extracted files:', allFiles.map(f => path.relative(tempExtract, f)));

    let srcExe = allFiles.find(f => path.basename(f).toLowerCase() === 'whisper-cli.exe')
      || allFiles.find(f => path.basename(f).toLowerCase() === 'main.exe')
      || allFiles.find(f => path.basename(f).toLowerCase() === 'whisper.exe');

    if (srcExe) {
      fs.copyFileSync(srcExe, targetCli);
      console.log('[download-whisper] Copied whisper executable to', targetCli);
    } else {
      console.error('[download-whisper] Could not find whisper executable in extracted files!');
    }

    // Copy any dll files that were bundled in the zip
    for (const f of allFiles) {
      if (f.toLowerCase().endsWith('.dll')) {
        const destDll = path.join(binNativeDir, path.basename(f));
        fs.copyFileSync(f, destDll);
        console.log('[download-whisper] Copied DLL:', path.basename(f));
      }
    }

    // Cleanup
    try {
      if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
      fs.rmSync(tempExtract, { recursive: true, force: true });
    } catch {}
  } else {
    console.log('[download-whisper] whisper-cli.exe already present:', targetCli);
  }

  console.log('[download-whisper] Done.');
}

main().catch(err => {
  console.error('[download-whisper] Error:', err);
  process.exit(1);
});
