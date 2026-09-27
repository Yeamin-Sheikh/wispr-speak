/**
 * Build script for native paste helper (win-paste.c -> tell-paste.exe)
 * Checks for available C compiler on Windows (gcc, clang, cl)
 * If none found, uses pre-compiled tell-paste.exe or nut-js runtime fallback.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_FILE = path.join(ROOT_DIR, 'src', 'native', 'win-paste.c');
const OUT_DIR = path.join(ROOT_DIR, 'bin', 'native');
const OUT_EXE = path.join(OUT_DIR, 'tell-paste.exe');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasCommand(cmd) {
  try {
    execSync(`where ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function build() {
  ensureDir(OUT_DIR);

  if (process.platform !== 'win32') {
    console.log('[build-native] Non-Windows platform detected; skipping native Windows helper build.');
    return;
  }

  if (hasCommand('gcc')) {
    console.log('[build-native] Compiling with GCC (MinGW)...');
    try {
      execSync(`gcc -O2 -s "${SRC_FILE}" -o "${OUT_EXE}"`, { stdio: 'inherit' });
      console.log('[build-native] Successfully compiled tell-paste.exe with GCC.');
      return;
    } catch (err) {
      console.error('[build-native] GCC build failed:', err.message);
    }
  }

  if (hasCommand('clang')) {
    console.log('[build-native] Compiling with Clang...');
    try {
      execSync(`clang -O2 "${SRC_FILE}" -o "${OUT_EXE}"`, { stdio: 'inherit' });
      console.log('[build-native] Successfully compiled tell-paste.exe with Clang.');
      return;
    } catch (err) {
      console.error('[build-native] Clang build failed:', err.message);
    }
  }

  if (hasCommand('cl')) {
    console.log('[build-native] Compiling with MSVC cl.exe...');
    try {
      execSync(`cl /O2 /Fe:"${OUT_EXE}" "${SRC_FILE}" user32.lib`, { stdio: 'inherit' });
      console.log('[build-native] Successfully compiled tell-paste.exe with MSVC.');
      return;
    } catch (err) {
      console.error('[build-native] MSVC build failed:', err.message);
    }
  }

  const VS2022_VCVARS = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
  const VS2019_VCVARS = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';

  if (fs.existsSync(VS2022_VCVARS)) {
    console.log('[build-native] Detected Visual Studio 2022 BuildTools; compiling tell-paste.exe...');
    try {
      execSync(`call "${VS2022_VCVARS}" && cl /O2 /Fo:"${OUT_DIR}/" /Fe:"${OUT_EXE}" "${SRC_FILE}" user32.lib`, { stdio: 'inherit' });
      try { const obj = path.join(OUT_DIR, 'win-paste.obj'); if (fs.existsSync(obj)) fs.unlinkSync(obj); } catch {}
      console.log('[build-native] Successfully compiled tell-paste.exe with MSVC 2022.');
      return;
    } catch (err) {
      console.error('[build-native] MSVC 2022 build failed:', err.message);
    }
  } else if (fs.existsSync(VS2019_VCVARS)) {
    console.log('[build-native] Detected Visual Studio 2019 BuildTools; compiling tell-paste.exe...');
    try {
      execSync(`call "${VS2019_VCVARS}" && cl /O2 /Fo:"${OUT_DIR}/" /Fe:"${OUT_EXE}" "${SRC_FILE}" user32.lib`, { stdio: 'inherit' });
      try { const obj = path.join(OUT_DIR, 'win-paste.obj'); if (fs.existsSync(obj)) fs.unlinkSync(obj); } catch {}
      console.log('[build-native] Successfully compiled tell-paste.exe with MSVC 2019.');
      return;
    } catch (err) {
      console.error('[build-native] MSVC 2019 build failed:', err.message);
    }
  }

  if (fs.existsSync(OUT_EXE)) {
    console.log('[build-native] Pre-compiled bin/native/tell-paste.exe found. Ready to use.');
  } else {
    console.log('[build-native] Notice: No C compiler found on PATH (gcc/clang/cl).');
    console.log('[build-native] The application will use @nut-tree-fork/nut-js key simulation as a fallback.');
  }
}

build();
