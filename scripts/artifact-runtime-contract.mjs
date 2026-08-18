export const PRODUCT_MIGRATION_PATHS = Object.freeze([
  "drizzle/20260801144629_foundation/migration.sql",
  "drizzle/20260802070444_unusual_robbie_robertson/migration.sql",
  "drizzle/20260802120436_late_sheva_callister/migration.sql",
  "drizzle/20260802123804_lumpy_old_lace/migration.sql",
  "drizzle/20260804140510_flippant_tenebrous/migration.sql",
  "drizzle/20260804163227_perpetual_secret_warriors/migration.sql",
  "drizzle/20260804164719_tearful_natasha_romanoff/migration.sql",
  "drizzle/20260804165335_fuzzy_vampiro/migration.sql",
  "drizzle/20260804165459_majestic_mach_iv/migration.sql",
  "drizzle/20260804174203_fresh_ultimo/migration.sql",
  "drizzle/20260804180557_spotty_catseye/migration.sql",
  "drizzle/20260807144527_amazing_kitty_pryde/migration.sql",
  "drizzle/20260808073614_normal_stature/migration.sql",
  "drizzle/20260817153223_small_power_pack/migration.sql",
  "drizzle/20260817162114_solid_daredevil/migration.sql",
  "drizzle/20260818060948_loose_kabuki/migration.sql",
]);

export function motionRuntimePaths(libraries) {
  const paths = [];
  for (const library of libraries) {
    paths.push(`motion-libraries/${library.packageName}/package.json`);
    for (const file of library.files) {
      paths.push(`motion-libraries/${library.packageName}/${file.packagePath}`);
    }
  }
  return new Set(paths);
}
