import PrivyBot from './privyBot.js';
import config from './config/index.js';

(async () => {
  try {
  const bot = new PrivyBot({
    browserUrl: config.BROWSER_URL,
    userDataDir: config.USER_DATA_DIR || './chrome-user-data',
  });
  console.log('Initializing bot...');
  await bot.init();

  console.log('Logging in...');
  await bot.login();

  console.log('Scraping properties...');
  const properties = await bot.scrape();

  console.log('Saving properties...');
  await bot.save(properties);

  console.log('Bot execution completed successfully.');
  await bot.keepSessionAliveLoop();
  } catch (error) {
    console.error('❌ An error occurred during bot execution:', error.message);
  }
})();