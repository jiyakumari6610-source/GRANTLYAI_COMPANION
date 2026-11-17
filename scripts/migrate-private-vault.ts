import 'dotenv/config';
import { checkFirebaseStorageHealth } from '../src/server/documentStorage.ts';
import { migratePrivateVaultToCloudStorage } from '../src/server/storageMigration.ts';

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const pruneVerifiedSource = args.has('--prune-verified');

  const health = await checkFirebaseStorageHealth();
  console.log('Storage bucket probe:', JSON.stringify(health, null, 2));

  const summary = await migratePrivateVaultToCloudStorage({
    dryRun,
    pruneVerifiedSource,
  });

  console.log('Migration summary:', JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Storage migration error:', err);
  process.exit(1);
});
