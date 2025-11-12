
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitForViews = async (page) => {
    // Return all matching containers currently mounted
    return await page.$$('.view-container, .grid-view-container, .map-view-container');
  };

const getClustersWithKeys = async (page) => {
  const handles = await page.$$('.cluster.cluster-deal');
  const clusters = [];

  for (const handle of handles) {
    const key = await handle.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return `${el.textContent?.trim()}@${Math.round(rect.x)}x${Math.round(rect.y)}`;
    });

    clusters.push({ handle, key });
  }

  return clusters;
};

const zoomMap = async (page, direction = "in") => {
  const deltaY = direction === "in" ? -300 : 300;
  await page.mouse.move(400, 300); // Center of map
  await page.mouse.wheel({ deltaY });
  console.log(direction === "in" ? "🔍 Zoomed In" : "🔎 Zoomed Out");
  await wait(1500); // Allow map to update
};

const getCurrentZoom = async (page) => {
  return await page.evaluate(() => {
    return window.map?.getZoom?.() ?? null;
  });
};

const clickClustersRecursively = async (
  page,
  browser,
  scrapeProperties,
  visited = new Set(),
  zoomLevel = 0,
  maxZoom = 21,
  minZoom = 3
) => {
  const viewsVisible = await waitForViews(page);

  if (viewsVisible.length > 0) {
    console.log('🎉 View containers loaded!');
    await scrapeProperties(page, browser);
    // Simulate a map click and zoom back to level 0
    await page.mouse.move(400, 300);
    await page.mouse.click(400, 300);
    while (zoomLevel > 0) {
      await zoomMap(page, "out");
      zoomLevel--;
    }
    return await clickClustersRecursively(page, browser, scrapeProperties, visited, 0, maxZoom, minZoom);
  }

  const clusters = await getClustersWithKeys(page);
  const unvisited = clusters.filter(c => !visited.has(c.key));

  if (unvisited.length === 0) {
    if (zoomLevel < maxZoom) {
      await zoomMap(page, "in");
      return await clickClustersRecursively(page, browser, scrapeProperties, visited, zoomLevel + 1, maxZoom, minZoom);
    } else if (zoomLevel > minZoom) {
      await zoomMap(page, "out");
      return await clickClustersRecursively(page, browser, scrapeProperties, visited, zoomLevel - 1, maxZoom, minZoom);
    } else {
      console.log("🛑 No more zoom levels or clusters to process.");
      return false;
    }
  }

  console.log(`📍 Found ${unvisited.length} unvisited cluster(s) at zoom level ${zoomLevel}`);
  for (const { handle, key } of unvisited) {
    try {
      await handle.click();
      visited.add(key);
      console.log(`✅ Clicked cluster ${key}`);
      await wait(1000);
      const viewsAfterClick = await waitForViews(page);
      if (viewsAfterClick.length > 0) {
        console.log("🎯 Target views loaded after clicking cluster!");
        await scrapeProperties(page);
        // Simulate a map click and zoom back to level 0
        await page.mouse.move(400, 1000);
        await page.mouse.click(400, 1000);
        while (zoomLevel > 0) {
          await zoomMap(page, "out");
          zoomLevel--;
        }
        return await clickClustersRecursively(page, browser, scrapeProperties, visited, 0, maxZoom, minZoom);
      }
    } catch (err) {
      console.warn(`⚠️ Could not click cluster ${key}: ${err.message}`);
    }
  }

  // Recurse again at this zoom level in case new clusters loaded
  return await clickClustersRecursively(page, browser, scrapeProperties, visited, zoomLevel, maxZoom, minZoom);
};

export { clickClustersRecursively };
