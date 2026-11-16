import {
  databaseUrlFromEnvironment,
  KyselyGameStateRepository,
} from "./repository.js";

export async function runDatabaseMigrations(): Promise<void> {
  const repository = KyselyGameStateRepository.open(databaseUrlFromEnvironment());
  try {
    await repository.migrate();
  } finally {
    await repository.close();
  }
}
