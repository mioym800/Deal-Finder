import {
  filterButtonSelector,
  priceFromSelector, priceToSelector,
  sqftFromSelector, sqftToSelector,
  hoaNoSelector,
  dateRangeSelect,
  filterApplyButton,
} from '../config/selection.js';

const typeAndDispatch = async (page, selector, value) => {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
};

const applyFilters = async (page /*, browser */) => {
  // Open the filter modal
  await page.waitForSelector(filterButtonSelector, { timeout: 10000 });
  await page.click(filterButtonSelector);

  // Price range
  await typeAndDispatch(page, priceFromSelector, 75000);
  await typeAndDispatch(page, priceToSelector,   750000);

  // Sq Ft range
  await typeAndDispatch(page, sqftFromSelector, 1000);
  await typeAndDispatch(page, sqftToSelector,   5000);

  // HOA => "No"
  await page.waitForSelector(hoaNoSelector, { timeout: 10000 });
  await page.evaluate((sel) => {
    const cb = document.querySelector(sel);
    if (!cb) return;
    // If checkbox exists and is not checked, check it
    if (cb.type === 'checkbox' && !cb.checked) {
      cb.click();
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, hoaNoSelector);

  // Date range => "all"
  await page.waitForSelector(dateRangeSelect, { timeout: 10000 });
  await page.select(dateRangeSelect, 'all');

  // Apply / close the modal
  await page.waitForSelector(filterApplyButton, { timeout: 10000 });
  await page.click(filterApplyButton);

  // Allow UI to settle
  await new Promise(r=>setTimeout(r,800));
  console.log('✅ Filters applied successfully');
};

export { applyFilters };