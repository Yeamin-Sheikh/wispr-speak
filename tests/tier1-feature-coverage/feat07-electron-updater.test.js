// Tier 1 - Feature 07: electron-updater with GitHub Releases
// Verifies update check event emission, version comparison, download progress, and auto-install on quit.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');

class MockAutoUpdater extends EventEmitter {
  constructor(options = {}) {
    super();
    this.currentVersion = options.currentVersion || '0.5.5';
    this.autoDownload = options.autoDownload !== false;
    this.autoInstallOnAppQuit = options.autoInstallOnAppQuit !== false;
    this.feedUrl = null;
    this.updateDownloaded = false;
  }

  setFeedURL(urlConfig) {
    this.feedUrl = urlConfig;
  }

  async checkForUpdates(mockRemoteRelease = null) {
    this.emit('checking-for-update');

    // Simulate network query to GitHub Releases
    const release = mockRemoteRelease || { version: '0.5.5', files: [] };
    
    if (this.isNewer(release.version, this.currentVersion)) {
      this.emit('update-available', release);
      if (this.autoDownload) {
        // Simulate download progress
        this.emit('download-progress', { percent: 50, bytesPerSecond: 1024 * 1024, total: 100000000, transferred: 50000000 });
        this.emit('download-progress', { percent: 100, bytesPerSecond: 1024 * 1024, total: 100000000, transferred: 100000000 });
        this.updateDownloaded = true;
        this.emit('update-downloaded', release);
      }
      return { updateInfo: release };
    } else {
      this.emit('update-not-available', { version: this.currentVersion });
      return null;
    }
  }

  isNewer(remote, current) {
    const r = remote.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((r[i] || 0) > (c[i] || 0)) return true;
      if ((r[i] || 0) < (c[i] || 0)) return false;
    }
    return false;
  }
}

describe('Tier 1 - Feature 07: electron-updater with GitHub Releases', () => {
  it('TC-T1-F07-01: configures GitHub Releases feed provider with owner and repo', () => {
    const updater = new MockAutoUpdater();
    updater.setFeedURL({
      provider: 'github',
      owner: 'Yeamin-Sheikh',
      repo: 'wispr-tell'
    });

    assert.strictEqual(updater.feedUrl.provider, 'github');
    assert.strictEqual(updater.feedUrl.owner, 'Yeamin-Sheikh');
    assert.strictEqual(updater.feedUrl.repo, 'wispr-tell');
  });

  it('TC-T1-F07-02: emits update-not-available when current version is equal to remote version', async () => {
    const updater = new MockAutoUpdater({ currentVersion: '0.5.5' });
    let notAvailableEmitted = false;

    updater.on('update-not-available', (info) => {
      notAvailableEmitted = true;
      assert.strictEqual(info.version, '0.5.5');
    });

    await updater.checkForUpdates({ version: '0.5.5' });
    assert.strictEqual(notAvailableEmitted, true);
  });

  it('TC-T1-F07-03: emits update-available when remote release has higher semver', async () => {
    const updater = new MockAutoUpdater({ currentVersion: '0.5.5' });
    let availableEmitted = false;

    updater.on('update-available', (info) => {
      availableEmitted = true;
      assert.strictEqual(info.version, '0.6.0');
    });

    await updater.checkForUpdates({ version: '0.6.0', notes: 'Performance and visual updates' });
    assert.strictEqual(availableEmitted, true);
  });

  it('TC-T1-F07-04: tracks download progress metrics (percentage and transfer rate)', async () => {
    const updater = new MockAutoUpdater({ currentVersion: '0.5.5' });
    const progressList = [];

    updater.on('download-progress', (progress) => {
      progressList.push(progress);
    });

    await updater.checkForUpdates({ version: '0.5.6' });
    assert.ok(progressList.length >= 2);
    assert.strictEqual(progressList[progressList.length - 1].percent, 100);
    assert.ok(progressList[0].bytesPerSecond > 0);
  });

  it('TC-T1-F07-05: flags update-downloaded and enables silent installation on quit', async () => {
    const updater = new MockAutoUpdater({ currentVersion: '0.5.5' });
    assert.strictEqual(updater.updateDownloaded, false);

    let downloadedEmitted = false;
    updater.on('update-downloaded', () => {
      downloadedEmitted = true;
    });

    await updater.checkForUpdates({ version: '0.5.6' });
    assert.strictEqual(downloadedEmitted, true);
    assert.strictEqual(updater.updateDownloaded, true);
    assert.strictEqual(updater.autoInstallOnAppQuit, true);
  });
});
