// ytm-preload.js — injected into the YTM webview before any page script runs
// This patches the navigator fingerprint before Google can check it

(function () {
  // Remove webdriver flag — #1 thing Google checks
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (_) {}

  // Patch userAgentData to look like real Chrome 120 on Windows
  try {
    const brands = [
      { brand: 'Google Chrome',  version: '120' },
      { brand: 'Chromium',       version: '120' },
      { brand: 'Not-A.Brand',    version: '99'  },
    ];
    const uaData = {
      brands,
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: (hints) => Promise.resolve({
        brands,
        mobile: false,
        platform: 'Windows',
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        uaFullVersion: '120.0.6099.130',
        fullVersionList: [
          { brand: 'Google Chrome', version: '120.0.6099.130' },
          { brand: 'Chromium',      version: '120.0.6099.130' },
          { brand: 'Not-A.Brand',   version: '99.0.0.0'       },
        ],
      }),
      toJSON: () => ({ brands, mobile: false, platform: 'Windows' }),
    };
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => uaData,
      configurable: true,
    });
  } catch (_) {}

  // Patch plugins to look like a real browser
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5], // non-empty
      configurable: true,
    });
  } catch (_) {}

  // Patch languages
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  } catch (_) {}
})();
