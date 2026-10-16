import { startApi } from "./start";

/**
 * `@bunbooru/api` — the REST API composition root. Boots the server (see
 * {@link startApi}), or with a `worker` argument only the background job
 * runner, and re-exports the wire types the web app's Eden client is typed
 * against.
 */
const [command] = process.argv.slice(2);
if (command !== undefined && command !== "worker") {
  console.error(`Unknown command "${command}". Usage: bunbooru [worker]`);
  process.exit(2);
}
await startApi({ mode: command === "worker" ? "worker" : "server" });

export type {
  ApiKeyDto,
  App,
  AssetDto,
  JobFailureDto,
  JobsOverviewDto,
  PageDto,
  SetupCheck as SetupCheckDto,
  TagAliasDto,
  TagDto,
  TagImplicationDto,
  TagVersionDto,
  UploadLimitsDto,
  UserDto,
} from "./server";
export type {
  RuntimeSection as RuntimeSectionDto,
  RuntimeSetting as RuntimeSettingDto,
  SettingSource,
} from "./lib/runtime-config";
export type { ExtensionInfo as ExtensionDto } from "./plugins/host";
