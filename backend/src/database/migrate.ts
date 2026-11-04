import {
  databaseUrlFromEnvironment,
  KyselyGameStateRepository,
} from "./repository.js";

let repository: KyselyGameStateRepository | undefined;
try {
  repository = KyselyGameStateRepository.open(databaseUrlFromEnvironment());
  await repository.migrate();
  console.log("Database migrations are up to date.");
} catch {
  console.error("Database migration failed. Check DATABASE_URL and database availability.");
  process.exitCode = 1;
} finally {
  await repository?.close();
}
