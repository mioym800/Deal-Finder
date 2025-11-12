const { runAllCities } = require('./runner');

(async () => {
  try {
    await runAllCities();
    console.log('Done.');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();