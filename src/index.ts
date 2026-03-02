import { Orchestrator } from './colony/Orchestrator';

async function main() {
  const colony = new Orchestrator();
  await colony.run();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});