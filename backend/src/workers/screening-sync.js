'use strict';

const { getConfigService } = require('../services/config-service');
const { OFACProvider } = require('../data-sources/screening/ofac');
const { FuzzyMatcher } = require('../data-sources/screening/fuzzy-matcher');

/**
 * Screening list sync worker.
 *
 * Designed to be called by a scheduled interval or on-demand trigger.
 * Idempotent — safe to re-run at any time.
 *
 * Each provider's updateList() call:
 *   - Downloads the latest list from the configured source URL
 *   - Upserts new/changed entries and removes delisted entries
 *   - Writes an immutable outcome row to screening_sync_events
 *   - Retries up to 3 times with exponential backoff on download failure
 */
async function syncScreeningLists() {
  const config = getConfigService();
  const fuzzyMatcher = new FuzzyMatcher();

  const providers = [
    new OFACProvider(config.screeningSources?.ofac_sdn || {}, fuzzyMatcher),
  ];

  // Add UKHMTProvider once spec #018 is implemented
  // providers.push(new UKHMTProvider(config.screeningSources?.uk_hmt || {}, fuzzyMatcher));

  const results = [];

  for (const provider of providers) {
    try {
      // Warn if the list is already stale before attempting sync
      const meta = await provider.getListMetadata();
      if (meta.isStale) {
        console.warn(
          `[screening-sync] WARN: ${provider.name} list is stale — last updated: ${meta.lastUpdated ?? 'never'}`
        );
      }

      console.log(`[screening-sync] Syncing ${provider.name}…`);
      const result = await provider.updateList();
      console.log(
        `[screening-sync] ${provider.name}: +${result.entriesAdded} -${result.entriesRemoved} ~${result.entriesModified}`
      );
      results.push({ provider: provider.name, ...result });
    } catch (err) {
      console.error(`[screening-sync] Failed to sync ${provider.name}:`, err.message);
      results.push({ provider: provider.name, error: err.message });
    }
  }

  return results;
}

module.exports = { syncScreeningLists };

// ─── Entry point when run as a standalone worker process ─────────────────────
if (require.main === module) {
  const config = getConfigService();
  config.load();

  syncScreeningLists()
    .then((results) => {
      console.log('[screening-sync] Initial sync done:', JSON.stringify(results));
      // Run every 24 hours
      setInterval(() => {
        syncScreeningLists().catch((err) =>
          console.error('[screening-sync] Periodic sync failed:', err.message)
        );
      }, 24 * 60 * 60 * 1000);
    })
    .catch((err) => {
      console.error('[screening-sync] Initial sync failed:', err.message);
      process.exit(1);
    });
}
