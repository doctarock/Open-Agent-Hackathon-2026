// The prepared cases whose evidence can be read from Zetaris, each with the
// query config that names its tables. npm run zetaris:seed loads all of them
// and npm run configure checks all of them, so a case never finds its tables
// missing. Why a list here and not the plugin's CASES: the scripts run without
// loading the plugin (and Speck with it); test/plugin.test.ts checks the two
// agree.
export const ZETARIS_CASES = [
  { id: "disputed-delivery", scenarioDir: "fixtures/scenarios/disputed-delivery", queries: "config/zetaris-queries.json" },
  { id: "hotel-chargeback", scenarioDir: "eval/challenge-7/hotel-chargeback", queries: "config/zetaris-queries-hotel.json" }
] as const;
