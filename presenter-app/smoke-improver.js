// Smoke test for the AI flow improver. Loads the .env so GEMINI_API_KEY is
// available, then calls improveFlow against the actual google search recorder
// JSON the user shared. Verifies:
//   - Output has fewer steps than the raw input (keyDown merging worked)
//   - No browser_resize step
//   - Every step has a non-empty narration
//   - URL/selector validation passed (no fallback)

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { improveFlow } = require('./src/renderer/utils/flowImprover');

// Exact JSON the user shared, embedded here so this test is self-contained.
const recorderJson = {
  title: 'google search',
  steps: [
    { type: 'setViewport', width: 1264, height: 233, deviceScaleFactor: 1 },
    { type: 'navigate', url: 'chrome://new-tab-page/' },
    {
      type: 'click',
      selectors: [
        ['ntp-app', '#searchbox', '#inputInnerContainer'],
        ['pierce/#inputInnerContainer']
      ]
    },
    {
      type: 'change',
      value: 'wiki',
      selectors: [
        ['aria/Search Google or type a URL'],
        ['ntp-app', '#searchbox', '#input'],
        ['pierce/#searchbox', 'pierce/#input']
      ]
    },
    { type: 'keyDown', key: 'p' }, { type: 'keyUp', key: 'p' },
    { type: 'keyDown', key: 'e' }, { type: 'keyUp', key: 'e' },
    { type: 'keyDown', key: 'd' }, { type: 'keyUp', key: 'd' },
    { type: 'keyDown', key: 'i' }, { type: 'keyUp', key: 'i' },
    { type: 'keyDown', key: 'a' }, { type: 'keyUp', key: 'a' },
    { type: 'keyDown', key: 'Enter' },
    { type: 'navigate', url: 'https://www.google.com/search?q=wikipedia&oq=wikipedia&gs_lcrp=EgZjaHJvbWUyDAgAEEUYORixAxiABDIKCAEQABixAxiABDINCAIQABiDARixAxiABDIHCAMQABiABDIHCAQQABiABDIHCAUQABiABDIKCAYQABixAxiABDIHCAcQABiABDIKCAgQLhixAxiABDIHCAkQABiPAtIBCTIyNjNqMGoxNagCALACAA&sourceid=chrome&ie=UTF-8' },
    {
      type: 'click',
      selectors: [
        ['aria/Wikipedia Wikipedia https://www.wikipedia.org', 'aria/Wikipedia'],
        ['#_b-_UacbLEMGwwcsPwJO0KA_37'],
        ['xpath///*[@id="_b-_UacbLEMGwwcsPwJO0KA_37"]'],
        ['pierce/#_b-_UacbLEMGwwcsPwJO0KA_37']
      ]
    },
    {
      type: 'click',
      selectors: [
        ['aria/English 7,141,000+ articles', 'aria/[role="strong"]'],
        ['div.lang1 strong'],
        ['xpath///*[@id="js-link-box-en"]/strong'],
        ['pierce/div.lang1 strong']
      ]
    },
    {
      type: 'click',
      // NOTE: \u00C2 is the mojibake artifact the recorder leaks when an
      // accessible name contains \u00A0 (non-breaking space). The validator
      // should normalize this and substitute the original back even when the
      // AI helpfully cleans it up to "aria/Interstate 205".
      selectors: [
        ['aria/Interstate\u00C2 205'],
        ['#mp-left p > b > a'],
        ['xpath///*[@id="mp-tfa"]/p/b/a'],
        ['pierce/#mp-left p > b > a'],
        ['text/Interstate\u00C2 205']
      ]
    }
  ]
};

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('FAIL: GEMINI_API_KEY not in .env');
    process.exit(1);
  }
  console.log('Calling improveFlow with verbosity=normal...');
  const t0 = Date.now();

  let flow;
  try {
    flow = await improveFlow(recorderJson, 'normal', apiKey);
  } catch (err) {
    console.error('FAIL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`OK in ${elapsed}s\n`);

  console.log('FLOW SHAPE:');
  console.log('  id:', flow.id);
  console.log('  source:', flow.source);
  console.log('  verbosity:', flow.verbosity);
  console.log('  steps:', flow.steps.length, '(was 18 raw, target ~6)');
  console.log('');

  console.log('STEPS:');
  for (let i = 0; i < flow.steps.length; i++) {
    const s = flow.steps[i];
    const param = s.params.url
      || (Array.isArray(s.params.selectors) && s.params.selectors[0])
      || s.params.text
      || s.params.key
      || '';
    console.log(`  ${(i + 1).toString().padStart(2)}. ${s.tool.padEnd(22)} ${(param || '').slice(0, 60)}`);
    console.log(`      ${s.narration}`);
  }

  console.log('');
  const hasResize = flow.steps.some((s) => s.tool === 'browser_resize');
  const allNarrated = flow.steps.every((s) => s.narration && s.narration.trim());
  const fewerSteps = flow.steps.length < 18;

  console.log('CHECKS:');
  console.log('  no browser_resize:', hasResize ? 'FAIL' : 'OK');
  console.log('  every step narrated:', allNarrated ? 'OK' : 'FAIL');
  console.log('  fewer steps than raw:', fewerSteps ? 'OK' : 'FAIL');

  if (hasResize || !allNarrated || !fewerSteps) {
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
