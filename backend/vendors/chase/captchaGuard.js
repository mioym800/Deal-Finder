// vendors/chase/captchaGuard.js
/**
 * Detects common "verify you're human" walls and returns a boolean.
 * We DO NOT solve them; we just report so the caller can stop/rotate/queue.
 */
export async function detectCaptcha(page) {
  const textSnippets = [
    'verify you are human',
    'unusual traffic',
    'solve this puzzle',
    'complete the security check',
    'are you a robot',
  ];

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 10000).toLowerCase());
  if (textSnippets.some(t => bodyText.includes(t))) return true;

  // Heuristic: many puzzle widgets live in iframes with keywords
  const hasPuzzleFrame = await page.$$eval('iframe', iframes =>
    (iframes || []).some(f => /captcha|arkoselabs|human|puzzle|challenge/i.test(f.src || ''))
  );
  return hasPuzzleFrame;
}